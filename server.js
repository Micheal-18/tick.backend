import express from "express";
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import admin from "firebase-admin";
import cors from "cors";
import QRCode from "qrcode";
import Brevo from "@getbrevo/brevo"; // ✅ Brevo SDK

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// ✅ Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ✅ Brevo Setup
const apiInstance = new Brevo.TransactionalEmailsApi();
apiInstance.authentications["apiKey"].apiKey = process.env.BREVO_API_KEY;

// ✅ Test route
app.get("/", (req, res) => res.send("🚀 Airticks backend is running!"));

// ✅ Purchase route
app.post("/api/purchase", async (req, res) => {
  try {
    const { reference, email, eventId, ticketType, ticketNumber } = req.body;
    console.log("Request body ===>>>", req.body);

    // ✅ Verify payment with Paystack
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const verifyData = await verifyRes.json();
    console.log("Paystack verify ===>>>", verifyData);

    if (!verifyData.status || verifyData.data.status !== "success") {
      return res.status(400).json({ error: "Payment not verified" });
    }

    // ✅ Update event in Firestore
    const eventRef = db.collection("events").doc(eventId);
    await eventRef.update({
      ticketSold: admin.firestore.FieldValue.increment(ticketNumber),
      revenue: admin.firestore.FieldValue.increment(
        (verifyData.data.amount * ticketNumber) / 100
      ),
    });
    console.log("✅ Event updated");

    // ✅ Save ticket in Firestore
    const ticketRef = db.collection("tickets").doc();
    await ticketRef.set({
      email,
      eventId,
      reference,
      ticketType,
      ticketNumber,
      amount: verifyData.data.amount / 100,
      status: verifyData.data.status,
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ✅ Generate QR code
    const qrCodeData = await QRCode.toDataURL(ticketRef.id);
    const qrBase64 = qrCodeData.split(",")[1];

    // ✅ Email template
    const htmlTemplate = `
      <div style="font-family: Arial, sans-serif; line-height:1.6; max-width:600px; margin:auto; border:1px solid #ddd; border-radius:12px; padding:20px;">
        <h2 style="color:#2C3E50; text-align:center;">🎫 Your Ticket is Confirmed!</h2>
        <p>Hello,</p>
        <p>Thank you for purchasing a ticket with <b>Airticks Event</b>. Below are your ticket details:</p>
        
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <tr><td><b>Event ID:</b></td><td>${eventId}</td></tr>
          <tr><td><b>Reference:</b></td><td>${reference}</td></tr>
          <tr><td><b>TicketNumber:</b></td><td>${ticketNumber}</td></tr>
          <tr><td><b>Amount:</b></td><td>₦${verifyData.data.amount / 100}</td></tr>
          <tr><td><b>Status:</b></td><td style="color:green;">${verifyData.data.status}</td></tr>
        </table>

       <p style="text-align:center;">Your ticket QR code is attached below 📎</p>

        <p style="font-size:12px; color:#555; text-align:center; margin-top:30px;">
          Scan the QR code at the event entrance to validate your ticket. <br>
          If you did not make this purchase, please contact support immediately.
        </p>
      </div>
    `;

    // ✅ Send Email via Brevo API
    const sendSmtpEmail = new Brevo.SendSmtpEmail();
    sendSmtpEmail.subject = "🎟 Your Airticks Ticket Confirmation";
    sendSmtpEmail.sender = { name: "Airticks Event", email: process.env.EMAIL_FROM };
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.htmlContent = htmlTemplate;
    sendSmtpEmail.attachment = [
      {
        name: "ticket-qr.png",
        content: qrBase64,
        type: "image/png",
      },
    ];

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✅ Email sent successfully via Brevo API");

    // ✅ Response
    res.json({
      success: true,
      ticketId: ticketRef.id,
      reference,
      eventId,
      amount: verifyData.data.amount / 100,
      status: verifyData.data.status,
    });
  } catch (err) {
    console.error("❌ API error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Airticks backend running on port ${PORT}`));
