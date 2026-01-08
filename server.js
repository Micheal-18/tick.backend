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
        fees,
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
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};


/* =======================
   WITHDRAW FUNDS
======================= */

const withdrawFunds = async ({ walletRef, amount, reason }) => {
  const walletSnap = await walletRef.get();
  if (!walletSnap.exists) throw new Error("Wallet not found");

  const wallet = walletSnap.data();

  if (wallet.balance < amount) throw new Error("Insufficient balance");

  // Create recipient if not exists
  let recipientCode = wallet.recipientCode;
  if (!recipientCode) {
    const recipientRes = await fetch(
      "https://api.paystack.co/transferrecipient",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "nuban",
          name: wallet.accountName || "Platform",
          account_number: wallet.accountNumber,
          bank_code: wallet.bankCode,
          currency: "NGN",
        }),
      }
    );

    const recipientData = await recipientRes.json();
    if (!recipientData.status) throw new Error(recipientData.message);

    recipientCode = recipientData.data.recipient_code;
    await walletRef.update({ recipientCode }); // cache for future
  }

  // Initiate transfer
  const transferRes = await fetch("https://api.paystack.co/transfer", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "balance",
      amount: Math.round(amount * 100),
      recipient: recipientCode,
      reason,
    }),
  });

  const transfer = await transferRes.json();
  if (!transfer.status) throw new Error(transfer.message);

  // Firestore transaction
  await admin.firestore().runTransaction(async (tx) => {
    tx.update(walletRef, {
      balance: admin.firestore.FieldValue.increment(-amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(admin.firestore().collection("withdrawals").doc(), {
      walletId: walletRef.id,
      amount,
      reference: transfer.data.reference,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(admin.firestore().collection("wallet_transactions").doc(), {
      walletId: walletRef.id,
      amount,
      type: "withdrawal",
      reference: transfer.data.reference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return transfer.data;
};

/* =======================
   ADMIN WITHDRAW
======================= */
app.post("/api/admin/withdraw", authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin only" });

  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

  try {
    const walletRef = admin.firestore().collection("wallets").doc("platform");
    const transferData = await withdrawFunds({
      walletRef,
      amount,
      reason: "Platform withdrawal",
    });

    res.json({ success: true, reference: transferData.reference });
  } catch (err) {
    console.error("Admin withdraw error:", err);
    res.status(500).json({ error: err.message || "Withdrawal failed" });
  }
});

/* =======================
   ORGANIZER WITHDRAW
======================= */
app.post("/api/withdraw", authenticate, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

  try {
    const organizerId = req.user.uid;
    const walletRef = admin.firestore().collection("wallets").doc(organizerId);

    const transferData = await withdrawFunds({
      walletRef,
      amount,
      reason: "Organizer withdrawal",
    });

    res.json({ success: true, reference: transferData.reference });
  } catch (err) {
    console.error("Organizer withdraw error:", err);
    res.status(500).json({ error: err.message || "Withdrawal failed" });
  }
});

app.get("/api/withdrawals", authenticate, async (req, res) => {
  try {
    const userId = req.user.uid;
    const isAdmin = req.user.isAdmin;

    let query = db.collection("withdrawals");

    // If not admin, only show their own withdrawals
    if (!isAdmin) {
      query = query.where("walletId", "==", userId);
    }

    const snap = await query.orderBy("createdAt", "desc").limit(20).get();

    const history = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate(),
    }));

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});



/* =======================
   SERVER START
======================= */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
