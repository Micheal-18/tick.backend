import express from "express";
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import admin from "firebase-admin";
import cors from "cors";
import QRCode from "qrcode";
import Brevo from "@getbrevo/brevo";
import crypto from "crypto";
import nodemailer from "nodemailer";

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


/* =======================
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

    if (payload.event !== "charge.success") {
      console.log("ℹ️ Ignored event:", payload.event);
      return res.sendStatus(200);
    }

    const { reference, metadata, customer, amount } = payload.data;
    const paidAmount = amount / 100; // naira

    console.log("Webhook metadata:", metadata);


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
    const eventSnap = await db.collection("events").doc(metadata.eventId).get();
    if (!eventSnap.exists) return res.sendStatus(200);

    if (!metadata || !metadata.eventId) {
  console.error("❌ Missing metadata.eventId", metadata);
  return res.sendStatus(200); // never crash webhook
}


    const eventDoc = eventSnap.data();
    const organizerId = eventDoc.ownerId;

    /* =========================
       WALLET SPLIT LOGIC
    ========================== */
    const PLATFORM_FEE_PERCENT = 8;

    const platformFee = Math.round(
      (paidAmount * PLATFORM_FEE_PERCENT) / 100
    );
    const organizerAmount = paidAmount - platformFee;

    /* =========================
       FIRESTORE TRANSACTION
    ========================== */
    const platformWalletRef = db.collection("wallets").doc("platform");
    const organizerWalletRef = db
      .collection("wallets")
      .doc("organizers")
      .collection("users")
      .doc(organizerId);

    const ticketRef = db.collection("tickets").doc();

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
       LEDGER (AUDIT LOG)
    ========================== */
    await db.collection("wallet_transactions").add({
      reference,
      eventId: metadata.eventId,
      organizerId,
      grossAmount: paidAmount,
      platformFee,
      organizerAmount,
      type: "ticket_sale",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.sendStatus(200);

    /* =========================
       EMAIL (ASYNC)
    ========================== */

    console.log("sending mail");
    console.log(customer);
    
    
    /* =========================
   EMAIL VIA BREVO API
========================= */
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
    console.log("📧 Email sent to", customer.email, metadata.fullName);

  } catch (err) {
    console.error("❌ Brevo email error:", err?.response?.body || err);
  }
});

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.sendStatus(500);
  }
});


/* =======================
   SERVER START
======================= */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
