import express from "express";
import dotenv from "dotenv";
dotenv.config();
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";
import admin from "firebase-admin";
import cors from "cors";
import QRCode from "qrcode";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" })); // allow Vite frontend

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
// ✅ Test route
app.get("/", (req, res) => {
  res.send("🚀 Backend is running!");
});


app.post("/api/purchase", async (req, res) => {
  try {
    const { reference, email, eventId, ticketType } = req.body;
    console.log(req.body, "===>>>> body");

    console.log(reference)
    console.log(eventId)
    console.log(email)
    // Verify with Paystack
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
    console.log(verifyData, "===>>>>> Verify data");

    // Ensure Paystack verification succeeded
    if (!verifyData.status || verifyData.data.status !== "success") {
      return res.status(400).json({ error: "Payment not verified" });
    }

    const eventRef = db.collection("events").doc(eventId);
    await eventRef.update({
      ticketsSold: admin.firestore.FieldValue.increment(1),
      revenue: admin.firestore.FieldValue.increment(verifyData.data.amount / 100),
    });
    console.log("Event updated");

    // Save ticket in Firestore

    const ticketRef = db.collection("tickets").doc();
    await ticketRef.set({
      email,
      eventId,
      reference,
      ticketType,
      amount: verifyData.data.amount / 100, // Paystack returns amount in kobo
      status: verifyData.data.status,
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const qrCodeData = await QRCode.toDataURL(ticketRef.id);
    const qrCodeBase64 = qrCodeData.replace(/^data:image\/png;base64,/, "");


    // Email HTML template
    const htmlTemplate = `
  <div style="font-family: Arial, sans-serif; line-height:1.6; max-width:600px; margin:auto; border:1px solid #ddd; border-radius:12px; padding:20px;">
    <h2 style="color:#2C3E50; text-align:center;">🎫 Your Ticket is Confirmed!</h2>
    <p>Hello,</p>
    <p>Thank you for purchasing a ticket with <b>Airticks Event</b>. Below are your ticket details:</p>
    
    <table style="width:100%; border-collapse:collapse; margin:20px 0;">
      <tr><td><b>Event ID:</b></td><td>${eventId}</td></tr>
      <tr><td><b>Reference:</b></td><td>${reference}</td></tr>
      <tr><td><b>Amount:</b></td><td>₦${verifyData.data.amount / 100}</td></tr>
      <tr><td><b>Status:</b></td><td style="color:green;">${verifyData.data.status}</td></tr>
    </table>

    <p style="text-align:center; margin:20px 0;">
      <img src="cid:ticketqr" alt="Ticket QR Code" style="width:200px; height:200px;" />
    </p>

    <p style="font-size:12px; color:#555; text-align:center; margin-top:30px;">
      Scan the QR code at the event entrance to validate your ticket. <br>
      If you did not make this purchase, please contact support immediately.
    </p>
  </div>
`;

    // (Optional) Send email here using nodemailer
    // Uncomment and configure correctly if needed
    const transporter = nodemailer.createTransport({
      host: "smtp-relay.brevo.com",
      port: 465,
      secure: true, // use true for port 465
      auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_SMTP_KEY,
      },
    });




    await transporter.sendMail({
      from: `"Airticks Event" <${process.env.EMAIL_FROM}>`,
      to: email,
      subject: "Your Ticket Confirmation",
      html: htmlTemplate,
      attachments: [
        {
          filename: "ticket-qr.png",
          content: qrCodeBase64,
          encoding: "base64",
          cid: "ticketqr", // 👈 this matches <img src="cid:ticketqr" />
        },
      ],
    });

    console.log("Email sent", transporter);


    res.json({
      success: true, ticketId: ticketRef.id, reference,
      eventId,
      amount: verifyData.data.amount / 100,
      status: verifyData.data.status,
    });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));


// app.listen(3000, () => console.log("✅ Backend running at http://localhost:3000"));
