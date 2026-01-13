import express from "express";
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import admin from "firebase-admin";
import cors from "cors";
import QRCode from "qrcode";
import Brevo from "@getbrevo/brevo";
import crypto from "crypto";

const app = express();
app.use(cors());

// Use raw body for webhook, JSON for other routes
app.use("/api/webhook/paystack", express.raw({ type: "application/json" }));
app.use(express.json());

/* =======================
   FIREBASE ADMIN
======================= */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

/* =======================
   BREVO EMAIL SETUP
======================= */
const emailApi = new Brevo.TransactionalEmailsApi();
emailApi.authentications["apiKey"].apiKey = process.env.BREVO_API_KEY;

/* =======================
   TEST ROUTE
======================= */
app.get("/", (req, res) => res.send("🚀 Airticks backend running"));

/* =======================
   CREATE PAYSTACK SUBACCOUNT
======================= */
app.post("/api/create-subaccount", async (req, res) => {
  try {
    const {
      business_name,
      account_number,
      bank_code,
      percentage_charge,
      primary_contact_email,
    } = req.body;

    if (!business_name || !account_number || !bank_code) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const response = await fetch("https://api.paystack.co/subaccount", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        business_name,
        settlement_bank: bank_code,
        account_number,
        percentage_charge: percentage_charge || 0,
        primary_contact_email,
      }),
    });

    const data = await response.json();

    if (!data.status) {
      return res.status(400).json({ error: data.message });
    }

    res.json({
      subaccount_code: data.data.subaccount_code,
    });
  } catch (err) {
    console.error("SUBACCOUNT ERROR:", err);
    res.status(500).json({ error: "Failed to create subaccount" });
  }
});


/* =======================
   INIT PAYMENT
======================= */
app.post("/api/init-payment", async (req, res) => {
  try {
    /* ===============================
       1. READ & VALIDATE INPUT
    =============================== */
    const { name, email, eventId, ticketLabel, ticketNumber } = req.body;

    if (!email || !eventId || !ticketLabel) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const qty = Number(ticketNumber);
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: "Invalid ticket quantity" });
    }

    /* ===============================
       2. FETCH EVENT
    =============================== */
    const eventSnap = await db.collection("events").doc(eventId).get();
    if (!eventSnap.exists) {
      return res.status(404).json({ error: "Event not found" });
    }

    const event = eventSnap.data();

    if (!event.subaccountCode) {
      return res.status(400).json({ error: "Organizer payout not configured" });
    }

    /* ===============================
       3. FIND TICKET
    =============================== */
    const ticket = event.price?.find(t => t.label === ticketLabel);
    if (!ticket) {
      return res.status(400).json({ error: "Ticket not found" });
    }

    const ticketPrice = Number(ticket.amount);
    if (isNaN(ticketPrice) || ticketPrice <= 0) {
      return res.status(400).json({ error: "Invalid ticket price" });
    }

    console.log("🧾 Incoming payload:", req.body);
    console.log("🎟 Event price array:", event.price);
    console.log("🎫 Selected ticket:", ticket);
    console.log("🔢 Ticket amount raw:", ticket.amount);
    console.log("🔢 Ticket qty raw:", qty);


    /* ===============================
       4. CALCULATE AMOUNT
    =============================== */
    const totalAmount = ticketPrice * qty;
    const amountInKobo = Math.round(totalAmount * 100);

    if (amountInKobo < 100) {
      return res.status(400).json({ error: "Amount too low for Paystack" });
    }

    /* ===============================
       5. INIT PAYSTACK
       (NO ADMIN FEE FOR NOW)
    =============================== */

    const paystackRes = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount: amountInKobo,
          subaccount: event.subaccountCode,
          transaction_charge: Math.round(amountInKobo * 0.08),
          metadata: {
            eventId,
            ticketLabel,
            ticketNumber: qty,
            platform: "airticks",
            fullName: name,
          },
        }),
      }
    );

    const data = await paystackRes.json();

    if (!data.status) {
      console.error("❌ Paystack error:", data);
      return res.status(400).json({ error: data.message });
    }

    /* ===============================
       6. SUCCESS RESPONSE
    =============================== */
    return res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
      amount: totalAmount, // naira (for frontend)
    });

  } catch (err) {
    console.error("INIT PAYMENT ERROR:", err);
    return res.status(500).json({ error: "Payment init failed" });
  }
});


/* =====================
   PAYSTACK WEBHOOK (Refactored)
======================= */
app.post("/api/webhook/paystack", async (req, res) => {
  try {
    /* =========================
       VERIFY PAYSTACK SIGNATURE
    ========================== */
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(req.body.toString());

    /* =========================
       CHARGE SUCCESS
    ========================== */
    if (payload.event === "charge.success") {
      const {
        reference,
        metadata,
        customer,
        amount,
      } = payload.data;

      if (!metadata?.eventId) {
        console.error("❌ Missing metadata.eventId");
        return res.sendStatus(200);
      }

      const paidAmount = amount / 100;
      const platformFee = Number((paidAmount * 0.08).toFixed(2));
      const organizerAmount = paidAmount - platformFee;


      /* =========================
         PREVENT DUPLICATES
      ========================== */
      const existing = await db
        .collection("tickets")
        .where("reference", "==", reference)
        .limit(1)
        .get();

      if (!existing.empty) return res.sendStatus(200);

      /* =========================
         FETCH EVENT
      ========================== */
      const eventRef = db.collection("events").doc(metadata.eventId);
      const eventSnap = await eventRef.get();
      if (!eventSnap.exists) return res.sendStatus(200);

      const eventDoc = eventSnap.data();
      const organizerId = eventDoc.ownerId;

      const platformWalletRef = db.collection("wallets").doc("platform");
      const organizerWalletRef = db.collection("wallets").doc(organizerId);
      const ticketRef = db.collection("tickets").doc();

      /* =========================
         FIRESTORE TRANSACTION
      ========================== */
      await db.runTransaction(async (tx) => {
        const platformSnap = await tx.get(platformWalletRef);
        const organizerSnap = await tx.get(organizerWalletRef);

        // Platform wallet
        tx.set(
          platformWalletRef,
          {
            balance: (platformSnap.data()?.balance || 0) + platformFee,
            totalEarned:
              (platformSnap.data()?.totalEarned || 0) + platformFee,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // Organizer wallet
        tx.set(
          organizerWalletRef,
          {
            balance:
              (organizerSnap.data()?.balance || 0) + organizerAmount,
            totalEarned:
              (organizerSnap.data()?.totalEarned || 0) + organizerAmount,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // Event stats
        tx.set(
          eventRef,
          {
            ticketSold: (eventDoc.ticketSold || 0) + metadata.ticketNumber,
            revenue: (eventDoc.revenue || 0) + paidAmount,
            balance: (eventDoc.balance || 0) + organizerAmount,
          },
          { merge: true }
        );

        // Ticket
        tx.set(ticketRef, {
          reference,
          eventId: metadata.eventId,
          eventName: eventDoc.name,
          ticketNumber: metadata.ticketNumber,
          amount: paidAmount,
          status: "success",
          used: false,
          email: customer.email,
          buyerName: metadata.fullName || customer.name || "Guest",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      /* =========================
         QR CODE
      ========================== */
      const qrData = await QRCode.toDataURL(ticketRef.id);
      const qrBase64 = qrData.split(",")[1];
      await ticketRef.update({ qr: qrBase64 });

      /* =========================
         WALLET LEDGER
      ========================== */
      await db.collection("wallet_transactions").add({
        reference,
        eventId: metadata.eventId,
        eventName: eventDoc.name,
        organizerId,
        grossAmount: paidAmount,
        platformFee,
        organizerAmount,
        type: "ticket_sale",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      /* =========================
         EMAIL (NON-BLOCKING)
      ========================== */
      setImmediate(async () => {
        try {
          const email = new Brevo.SendSmtpEmail();

          email.subject = "🎫 Your Ticket Confirmation";
          email.sender = {
            name: "Airticks Event",
            email: process.env.EMAIL_FROM,
          };

          email.to = [
            {
              email: customer.email,
              name: metadata.fullName || "Guest",
            },
          ];

          email.htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; padding:20px; border:1px solid #eee; border-radius:12px;">
              <h2 style="text-align:center;">🎉 Ticket Confirmed!</h2>
              <p>Hello ${metadata.fullName || "Guest"},</p>

              <p>Your ticket for <b>${eventDoc.name}</b> has been successfully confirmed.</p>

              <table style="width:100%; margin:16px 0;">
                <tr><td><b>Reference</b></td><td>${reference}</td></tr>
                <tr><td><b>Tickets</b></td><td>${metadata.ticketNumber}</td></tr>
                <tr><td><b>Amount</b></td><td>₦${paidAmount}</td></tr>
                <tr><td><b>Status</b></td><td style="color:green;">SUCCESS</td></tr>
              </table>

              <p style="text-align:center;">
                <img src="data:image/png;base64,${qrBase64}" width="200" />
              </p>

              <p style="font-size:12px; color:#777; text-align:center;">
                Scan this QR code at the event entrance.
              </p>
            </div>
          `;

          await emailApi.sendTransacEmail(email);
          console.log("📧 Email sent to", customer.email);

        } catch (err) {
          console.error("❌ Brevo email error:", err?.response?.body || err);
        }
      });
    }

    /* =========================
       TRANSFER SUCCESS
    ========================== */
    if (payload.event === "transfer.success") {
      const ref = payload.data.reference;

      const snap = await db
        .collection("withdrawals")
        .where("reference", "==", ref)
        .limit(1)
        .get();

      if (!snap.empty) {
        await snap.docs[0].ref.update({
          status: "success",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

const withdrawal = snap.docs[0].data();

await db.collection("events").doc(withdrawal.eventId).update({
  isWithdrawing: false,
});

      }
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ PAYSTACK WEBHOOK ERROR:", err);
    return res.sendStatus(500);
  }
});


const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    // 1️⃣ Verify Firebase ID token
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // uid, email, etc.

    // 2️⃣ Fetch user from Firestore
    const userSnap = await db.collection("users").doc(decoded.uid).get();
    if (!userSnap.exists) {
      return res.status(401).json({ error: "User not found" });
    }

    const userData = userSnap.data();
    req.user.isAdmin = userData.isAdmin === true; // check the field in your users doc

    next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({ error: "Invalid token" });
  }
};



/* =======================
   ADMIN FETCH WITHDRAW REQUESTS
======================= */
app.get("/api/admin/withdraw/requests", authenticate, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: "Admin only" });
  }

  try {
    const snap = await db
      .collection("withdraw_requests")
      .orderBy("createdAt", "desc")
      .get();

    const requests = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate(),
    }));

    res.json(requests);
  } catch (err) {
    console.error("Admin fetch error:", err);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

/* =======================
   ADMIN WITHDRAW
======================= */

// Example backend helper
const payWithPaystack = async ({ amount, accountNumber, bankCode, accountName, reason }) => {
  // 1. Create transfer recipient
  const resRecipient = await fetch("https://api.paystack.co/transferrecipient", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "nuban",
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    }),
  });
  const recipientData = await resRecipient.json();
  if (!recipientData.status) throw new Error(recipientData.message);

  // 2. Initiate transfer
  const resTransfer = await fetch("https://api.paystack.co/transfer", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "balance",
      amount: amount * 100,
      recipient: recipientData.data.recipient_code,
      reason,
    }),
  });
  const transferData = await resTransfer.json();
  if (!transferData.status) throw new Error(transferData.message);

  return transferData.data;
};


app.post("/api/admin/withdraw/pay", authenticate, async (req, res) => {
  if (!req.user.isAdmin)
    return res.status(403).json({ error: "Admin only" });

  const { requestId } = req.body;
  if (!requestId)
    return res.status(400).json({ error: "requestId required" });

  try {
    const db = admin.firestore();

    // 1. Fetch withdraw request
    const requestRef = db.collection("withdraw_requests").doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists)
      return res.status(404).json({ error: "Request not found" });

    const request = requestSnap.data();
    if (request.status !== "pending")
      return res.status(400).json({ error: "Already processed" });

    // 2. Fetch event
    const eventRef = db.collection("events").doc(request.eventId);
    const eventSnap = await eventRef.get();

    if (!eventSnap.exists)
      return res.status(404).json({ error: "Event not found" });

    const event = eventSnap.data();

    if (event.balance < request.amount)
      return res.status(400).json({ error: "Insufficient event balance" });

    // 3. Paystack payout
    const transfer = await payWithPaystack({
      amount: request.amount,
      accountNumber: event.accountNumber,
      bankCode: event.bankCode,
      accountName: event.accountName,
      reason: `Payout for ${event.name}`,
    });

    // 4. Firestore transaction
    await db.runTransaction(async (tx) => {
      tx.update(eventRef, {
        balance: admin.firestore.FieldValue.increment(-request.amount),
      });

      tx.update(requestRef, {
        status: "success",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        reference: transfer.reference,
      });

      tx.set(db.collection("wallet_transactions").doc(), {
        organizerId: request.organizerId,
        eventId: request.eventId,
        amount: request.amount,
        type: "withdrawal",
        reference: transfer.reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({
      success: true,
      reference: transfer.reference,
    });
  } catch (err) {
    console.error("Admin payout error:", err);
    res.status(500).json({ error: err.message });
  }
});


/* =======================
   ORGANIZER reQUEST WITHDRAWAL
======================= */
app.post("/api/withdraw/requests", authenticate, async (req, res) => {
  const { amount, eventId } = req.body;
  const organizerId = req.user.uid;

  if (!eventId || !amount || amount <= 0)
    return res.status(400).json({ error: "Invalid request" });

  const eventRef = db.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();

  if (!eventSnap.exists)
    return res.status(404).json({ error: "Event not found" });

  const event = eventSnap.data();

  if (event.ownerId !== organizerId)
    return res.status(403).json({ error: "Not your event" });

  if (event.balance < amount)
    return res.status(400).json({ error: "Insufficient balance" });

  await db.collection("withdraw_requests").add({
    organizerId,
    eventId,
    eventName: event.name,
    amount,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ success: true });
});


app.get("/api/withdrawals", authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const isAdmin = req.user.isAdmin;

    // 1️⃣ Withdraw requests (pending / paid)
    let reqQuery = db.collection("withdraw_requests");
    if (!isAdmin) {
      reqQuery = reqQuery.where("organizerId", "==", uid);
    }

    const reqSnap = await reqQuery.get();
    const requests = reqSnap.docs.map(doc => ({
      id: doc.id,
      amount: doc.data().amount,
      status: doc.data().status,        // pending | paid
      reference: doc.data().reference || null,
      createdAt: doc.data().createdAt?.toDate(),
    }));

    // 2️⃣ Wallet ledger (success)
    let ledgerQuery = db
      .collection("wallet_transactions")
      .where("type", "==", "withdrawal");

    if (!isAdmin) {
      ledgerQuery = ledgerQuery.where("organizerId", "==", uid);
    }

    const ledgerSnap = await ledgerQuery.get();
    const ledger = ledgerSnap.docs.map(doc => ({
      id: doc.id,
      amount: doc.data().amount,
      status: "success",
      reference: doc.data().reference,
      createdAt: doc.data().createdAt?.toDate(),
    }));

    // 3️⃣ Merge & sort
    const combined = [...requests, ...ledger].sort(
      (a, b) => b.createdAt - a.createdAt
    );

    res.json(combined);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
});


/* =======================
   SERVER START
======================= */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
