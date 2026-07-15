import express from 'express'
import dotenv from 'dotenv'
dotenv.config()
import fetch from 'node-fetch'
import admin from 'firebase-admin'
import cors from 'cors'
import QRCode from 'qrcode'
import Brevo from '@getbrevo/brevo'
import crypto from 'crypto'
import { GoogleGenAI } from "@google/genai";
import axios from "axios";
import nodemailer from "nodemailer";



const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const app = express()
app.use(cors())

// Use raw body for webhook, JSON for other routes
app.use('/api/webhook/paystack', express.raw({ type: 'application/json' }))
app.use(express.json())

/* =======================
   FIREBASE ADMIN
======================= */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
}
const db = admin.firestore()

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    // 1️⃣ Verify Firebase ID token
    const decoded = await admin.auth().verifyIdToken(token)
    req.user = decoded // uid, email, etc.

    // 2️⃣ Fetch user from Firestore
    const userSnap = await db.collection('users').doc(decoded.uid).get()
    if (!userSnap.exists) {
      return res.status(401).json({ error: 'User not found' })
    }

    const userData = userSnap.data()
    req.user.isAdmin = userData.isAdmin === true // check the field in your users doc

    next()
  } catch (err) {
    console.error(err)
    return res.status(401).json({ error: 'Invalid token' })
  }
}

/* =======================
   BREVO EMAIL SETUP
======================= */
const emailApi = new Brevo.TransactionalEmailsApi()
emailApi.authentications['apiKey'].apiKey = process.env.BREVO_API_KEY

/* =======================
   TEST ROUTE
======================= */
app.get('/', (req, res) => res.send('🚀 Airticks backend running'))

app.post("/send-message", async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: "All fields are required." });
  }

  try {
    // Configure Brevo SMTP
    const transporter = nodemailer.createTransport({
      host: "smtp-relay.brevo.com",
      port: 587,
      auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_SMTP_KEY,
      },
    });

    // Message details
    const mailOptions = {
      from: `"Airticks Contact" <${process.env.EMAIL_FROM}>`,
      to: "michaeleleke259@gmail.com", // 👈 your real inbox
      subject: `New message from ${name}`,
      html: `
        <h2>New Contact Message</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent to your inbox");
    res.status(200).json({ success: true, message: "Message sent successfully!" });
  } catch (error) {
    console.error("❌ Error sending email:", error);
    res.status(500).json({ error: "Failed to send message." });
  }
});

app.post("/api/description", async (req, res) => {
  try {
    const { name, category, venue, description } = req.body;

    const prompt = `
You are an event marketing expert.
Improve this event description.

Event Name: ${name}
Category: ${category}
Location: ${venue}

Current Description:
${description}

Rules:
- Return ONLY the final description.
- Do NOT use Markdown.
- Do NOT use **bold**.
- Do NOT use *italics*.
- Do NOT use bullet points.
- Do NOT use headings.
- Do NOT use quotation marks.
- Do NOT add labels like "Description:".
- Keep it under 300 words.
- Make it sound human and exciting.
- Write it as one or two natural paragraphs.
- Start directly with the description.
`;

    // FIX: Using the correct, globally available text model
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", 
      contents: prompt,
    });

    res.json({
      description: response.text,
    });
  } catch (err) {
    console.error("Description Generation Error:", err);
    res.status(500).json({
      error: "Failed to generate description.",
    });
  }
});

// Endpoint 2: Generate Event Flyer Background
app.post("/api/flyer", async (req, res) => {
  try {
    const { name, category, description, location, organizer} = req.body;

    // Let Gemini improve the prompt
    const promptResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `
You are an expert graphic designer.

Create a concise image prompt for an AI image generator.

Event:
${name}

Category:
${category}

Organizer:
${organizer}

Location:
${location}

Description:
${description}


Requirements:
- Premium event poster
- Vibrant colors based on the event description
- Modern lighting
- Luxury style
- High contrast
- Cinematic
- Vertical 3:4
- Background only
- No text
- No logos
- Leave empty space for event information
`,
    });

    const prompt =
      typeof promptResponse.text === "function"
        ? promptResponse.text()
        : promptResponse.text;

    // Encode the prompt
    const encodedPrompt = encodeURIComponent(prompt);

    // Pollinations image URL
    const imageUrl =
      `https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=1024&model=flux&nologo=true`;
    // Download the generated image
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });

    // Convert image to base64
    const base64 = Buffer.from(imageResponse.data, "binary").toString("base64");

    res.json({
      image: `data:image/png;base64,${base64}`,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to generate flyer.",
    });
  }
});

app.get("/api/banks", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.paystack.co/bank?country=nigeria",
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!data.status) {
      return res.status(400).json({
        error: data.message,
      });
    }

    res.json(data.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Unable to fetch banks",
    });
  }
});

app.post("/api/resolve-account", async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;

    if (!accountNumber || !bankCode) {
      return res.status(400).json({
        error: "Missing account details",
      });
    }

    const response = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!data.status) {
      return res.status(400).json({
        error: data.message,
      });
    }

    res.json({
      accountName: data.data.account_name,
      accountNumber: data.data.account_number,
      bankId: data.data.bank_id,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Unable to resolve account",
    });
  }
});

/* =======================
   CREATE PAYSTACK SUBACCOUNT
======================= */
app.post('/api/create-subaccount', async (req, res) => {
  try {
    const {
      business_name,
      account_number,
      bank_code,
      percentage_charge,
      primary_contact_email
    } = req.body

    if (!business_name || !account_number || !bank_code) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const response = await fetch('https://api.paystack.co/subaccount', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        business_name,
        settlement_bank: bank_code,
        account_number,
        percentage_charge: percentage_charge || 0,
        primary_contact_email
      })
    })

    const data = await response.json()

    if (!data.status) {
      return res.status(400).json({ error: data.message })
    }

    await db.collection('subaccounts').doc(data.data.subaccount_code).set({
      organizerId: req.body.organizerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    })

    res.json({
      subaccount_code: data.data.subaccount_code
    })
  } catch (err) {
    console.error('SUBACCOUNT ERROR:', err)
    res.status(500).json({ error: 'Failed to create subaccount' })
  }
})

/* =======================
   INIT PAYMENT (With Free Ticket Bypass)
======================= */
app.post('/api/init-payment', async (req, res) => {
  try {
    /* ===============================
       1. READ & VALIDATE INPUT
    =============================== */
const {
    name,
    email,
    eventId,
    ticketId,
    ticketName,
    ticketType,
    ticketCurrency,
    ticketQuantity,
    ticketPrice,
    userId,
    attendees = []
} = req.body;


    if (!email || !eventId || !ticketId || !ticketName || !ticketType || !ticketCurrency || ticketPrice === undefined) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const qty = Number(ticketQuantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Invalid ticket quantity' })
    }

    const attendeesList =
      Array.isArray(attendees) && attendees.length > 0
        ? attendees
        : [
            {
              name: name || "Guest",
              email: email.toLowerCase(),
              isBuyer: true,
            },
          ];

          const emails = attendeesList.map(a =>
              a.email.toLowerCase()
          );

          if (new Set(emails).size !== emails.length) {
              return res.status(400).json({
                  error: "Duplicate attendee emails are not allowed."
              });
          }

    if (attendeesList.length !== qty) {
      return res.status(400).json({
        error: "Attendee count does not match ticket quantity."
      });
    }
/* ===============================
       2. FETCH EVENT
    =============================== */
    const eventSnap = await db.collection('events').doc(eventId).get()
    if (!eventSnap.exists) {
      return res.status(404).json({ error: 'Event not found' })
    }

    const event = eventSnap.data()
    console.log(event);

    /* ===============================
       3. FIND TICKET
    =============================== */
    const ticketList = Array.isArray(event.tickets)
        ? event.tickets
        : Array.isArray(event.price)
        ? event.price
        : [];

    const ticket = ticketList.find(t => t.id === ticketId);

    if (!ticket) {
        return res.status(400).json({
            error: "Ticket type not found"
        });
    }

    if (isNaN(ticketPrice) || ticketPrice < 0) {
      return res.status(400).json({ error: 'Invalid ticket price configuration' })
    }

    const totalAmount = ticketPrice * qty

    /* ============================================================
       ⚡ SHORT-CIRCUIT ROUTE FOR FREE TICKETS (0 NAIRA / 0 DOLLARS)
    ============================================================ */
    if (totalAmount === 0 || event.isFree === true) {
      const freeReference = `FREE-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
      const organizerId = event.ownerId
      const ticketIds = [];

      const ticketField = Array.isArray(event.tickets)
      ? "tickets"
      : "price";

      const updatedTickets = ticketList.map(t => {
          if (t.id !== ticketId) return t;

          return {
              ...t,
              sold: (t.sold || 0) + qty
          };
      });
      await db.runTransaction(async (tx) => {
        tx.set(eventSnap.ref,{
        [ticketField]: updatedTickets,
        ticketSold: admin.firestore.FieldValue.increment(qty),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },{ merge:true });

    for (const [index, attendee] of attendeesList.entries()) {
        const ticketRef = db.collection("tickets").doc();
        const ticketId = ticketRef.id;

        const qrUrl = `${process.env.FRONTEND_URL}/ticket/${ticketId}`;
        const qrData = await QRCode.toDataURL(qrUrl,{
            width:320,
            margin:1,
            errorCorrectionLevel:"M",
        });

        const qrBase64 = qrData.replace(
            /^data:image\/png;base64,/,
            ""
        );

        tx.set(ticketRef,{
            ticketId,
            reference: freeReference,
            parentReference: freeReference,
            ticketIndex:index,
            organizerId,
            userId:userId || null,
            eventId,
            eventName:event.name,
            ticketType:ticketName,
            currency: ticket.currency,
            location:event.location || "TBA",
            amount:0,
            buyerName: attendee.name,
            email: attendee.email.toLowerCase(),

            attendeeName: attendee.name,
            attendeeEmail: attendee.email.toLowerCase(),

            purchaserName: name,
            purchaserEmail: email.toLowerCase(),
            totalTickets: attendeesList.length,
            ticketQuantity: qty,
            maxPerPerson: ticket.maxPerPerson,
            isBuyer: attendee.isBuyer,
            qr:qrBase64,
            status:"success",
            used:false,
            createdAt:admin.firestore.FieldValue.serverTimestamp()
        });

        ticketIds.push({
            ticketId,
            attendee
        });
    }
  });
      // 3. Dispatch the ticket via Brevo immediately (Non-blocking worker thread)
      setImmediate(async () => {
        for (const { ticketId, attendee } of ticketIds) {
          try {
            const ticketSnap = await db.collection("tickets").doc(ticketId).get();

            if (!ticketSnap.exists) continue;

            const ticket = ticketSnap.data();

            const emailPayload = new Brevo.SendSmtpEmail();

            emailPayload.subject = `🎫 Your Free Ticket for ${event.name}`;

            emailPayload.sender = {
              name: "Airticks Events",
              email: process.env.EMAIL_FROM,
            };

            emailPayload.to = [
              {
                email: ticket.email,
                name: ticket.buyerName,
              },
            ];

            emailPayload.attachment = [
              {
                name: "ticket-qr.png",
                content: ticket.qr,
              },
            ];

            const intro = ticket.isBuyer
              ? `
                  <p>Your free registration for <b>${event.name}</b> has been confirmed.</p>

                  <p>Your personal ticket is attached below.</p>
                `
              : `
                  <p><strong>${ticket.purchaserName}</strong> has registered you for <b>${event.name}</b>.</p>

                  <p>This QR code belongs only to you.</p>
                `;

            emailPayload.htmlContent = `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;border:1px solid #eee;border-radius:12px;">

              <h2 style="text-align:center;color:#16a34a;">
                  🎉 Free Ticket Confirmed
              </h2>

              <p>Hello <strong>${ticket.buyerName}</strong>,</p>

              ${intro}

              <div style="text-align:center;margin:20px 0;">
                  <img src="data:image/png;base64,${ticket.qr}" width="220"/>
              </div>

              <table style="width:100%;border-collapse:collapse;">

                  <tr>
                      <td><strong>Event</strong></td>
                      <td>${event.name}</td>
                  </tr>

                  <tr>
                      <td><strong>Ticket Type</strong></td>
                      <td>${ticket.ticketType}</td>
                  </tr>

                  <tr>
                      <td><strong>Price</strong></td>
                      <td style="color:green;font-weight:bold;">FREE</td>
                  </tr>

                  <tr>
                      <td><strong>Reference</strong></td>
                      <td>${ticketId}</td>
                  </tr>

              </table>

              <p style="font-size:12px;color:#777;text-align:center;margin-top:20px;">
                  Please present this QR code at the event entrance.
              </p>

            </div>
            `;

            await emailApi.sendTransacEmail(emailPayload);

            console.log("✅ Free ticket email sent:", ticket.email);

          } catch (err) {
            console.error("❌ Free ticket email error:", attendee.email, err);
          }
          }
        });

      // 4. Return success to the frontend instantly so it knows there's no redirect URL needed
      return res.json({
        success: true,
        isFree: true,
        reference: freeReference,
        message: 'Free ticket generated successfully!'
      })
    }

    /* ============================================================
       💳 PAID TICKETS WORKFLOW (PAYSTACK ROUTING CONTINUES BELOW)
    ============================================================ */
    if (!event.subaccountCode) {
      return res.status(400).json({ error: 'Organizer payout routing parameters are unconfigured.' })
    }

    const amountInKobo = Math.round(totalAmount * 100)
    if (amountInKobo < 100) {
      return res.status(400).json({ error: 'Amount too low for Paystack channels processing.' })
    }

    console.log('🧾 Processing Paid Ticket Checkout Routing:', ticketName)

    const paystackRes = await fetch(
      'https://api.paystack.co/transaction/initialize',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          amount: amountInKobo,
          subaccount: event.subaccountCode,
          callback_url: `${process.env.FRONTEND_URL}/payment-success`,
          metadata: {
            eventId,
            ticketId,
            ticketName,
            ticketPrice,
            ticketCurrency,
            ticketNumber: qty,
            platform: 'airticks',
            userId: userId || null,
            fullName: name,
            attendees: attendeesList,// Pass attendee list if provided
          }
        })
      }
    )

    const data = await paystackRes.json()

    if (!data.status) {
      console.error('❌ Paystack verification failure:', data)
      return res.status(400).json({ error: data.message })
    }

    return res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
      amount: totalAmount
    })
  } catch (err) {
    console.error('INIT PAYMENT ERROR:', err)
    return res.status(500).json({ error: 'Payment initialization sequence faulted.' })
  }
})

/* =====================
   PAYSTACK WEBHOOK (Refactored)
======================= */
app.post('/api/webhook/paystack', async (req, res) => {
  try {
    /* =========================
       VERIFY PAYSTACK SIGNATURE
    ========================== */
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex')

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Invalid signature')
    }

    const payload = JSON.parse(req.body.toString())

    /* =========================
       CHARGE SUCCESS
    ========================== */
    if (payload.event === 'charge.success') {
      const { reference, metadata, customer, amount } = payload.data

      if (!metadata?.eventId) {
        console.error('❌ Missing metadata.eventId')
        return res.sendStatus(200)
      }

      const paidAmount = amount / 100
      const platformFee = Number((paidAmount * 0.08).toFixed(2))
      const organizerAmount = paidAmount - platformFee

      /* =========================
         PREVENT DUPLICATES
      ========================== */
      // Prevent duplicate webhook processing
      const existingWalletTx = await db
        .collection('wallet_transactions')
        .where('reference', '==', reference)
        .limit(1)
        .get()

      if (!existingWalletTx.empty) {
        console.log('⚠️ Duplicate webhook for reference:', reference)
        return res.sendStatus(200)
      }

      /* =========================
         FETCH EVENT
      ========================== */
      const eventRef = db.collection('events').doc(metadata.eventId)
      const eventSnap = await eventRef.get()
      if (!eventSnap.exists) return res.sendStatus(200)

      const eventDoc = eventSnap.data()
      const organizerId = eventDoc.ownerId
      const ticketQty = Number(metadata.ticketNumber) || 1

      /* =========================
         DETERMINE ATTENDEES LIST
      ========================== */
      // If attendees were provided, use them. Otherwise, create single attendee from buyer
      const attendeesList =
          Array.isArray(metadata.attendees) &&
          metadata.attendees.length > 0
              ? metadata.attendees
              : [
                  {
                      name: metadata.fullName || customer.name || "Guest",
                      email: customer.email,
                      isBuyer: true,
                  },
              ];

        const emails = attendeesList.map(a =>
              a.email.toLowerCase()
          );

          if (new Set(emails).size !== emails.length) {
              return res.status(400).json({
                  error: "Duplicate attendee emails are not allowed."
              });
          }

      /* ============================================================
         ⚡ PERFORMANCE OPTIMIZATION: PRE-GENERATE TICKET IDS & QR CODES
         (Keeps the Firestore Transaction lightweight and deterministic)
      ============================================================ */
      const preparedTickets = [];
      const ticketIds = [];

      for (const [index, attendee] of attendeesList.entries()) {
        const ticketRef = db.collection('tickets').doc();
        const ticketId = ticketRef.id;

        const qrUrl = `${process.env.FRONTEND_URL}/ticket/${ticketId}`;
        const qrData = await QRCode.toDataURL(qrUrl, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        const qrBase64 = qrData.replace(/^data:image\/png;base64,/, '');

        preparedTickets.push({
          ticketRef,
          ticketId,
          index,
          attendee,
          qrBase64
        });

        ticketIds.push({ ticketId, attendee });
      }

      /* ============================================================
         💼 TRANSACTION WORKFLOW (WALLETS, COUNT, & DATA WRITE)
      ============================================================ */
      await db.runTransaction(async tx => {
        const platformWalletRef = db.collection('wallets').doc('platform');
        const organizerWalletRef = db.collection('wallets').doc(organizerId);


        // Update Wallet Metrics
        tx.set(platformWalletRef, {
          balance: admin.firestore.FieldValue.increment(platformFee),
          totalRevenue: admin.firestore.FieldValue.increment(platformFee),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        tx.set(organizerWalletRef, {
          pendingBalance: admin.firestore.FieldValue.increment(organizerAmount),
          totalEarnings: admin.firestore.FieldValue.increment(organizerAmount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Update Event Ticket metrics
        tx.set(eventRef, {
          ticketSold: admin.firestore.FieldValue.increment(ticketQty),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const ticketField = eventDoc.tickets ? "tickets" : "price";

        const ticketList = eventDoc[ticketField] || [];

        const updatedTickets = ticketList.map(t => {
            if (t.id !== metadata.ticketId) return t;

            return {
                ...t,
                sold: (t.sold || 0) + ticketQty,
            };
        });

        tx.update(eventRef, {
            [ticketField]: updatedTickets,
        });

        // Write batch tickets
        for (const item of preparedTickets) {
          tx.set(item.ticketRef, {
            ticketId: item.ticketId,
            reference,
            parentReference: reference,
            ticketIndex: item.index,

            organizerId,
            userId: metadata.userId || null,

            eventId: metadata.eventId,
            eventName: eventDoc.name,
            ticketType: metadata.ticketName,
            ticketQuantity:ticketQty,
            totalTickets:attendeesList.length,
            location: eventDoc.location || "TBA",
            currency:metadata.ticketCurrency,

            amount: Number(metadata.ticketPrice || 0),

            // Unified field naming matching frontend lookups & verification schemas
            buyerName: item.attendee.name,
            email: item.attendee.email.toLowerCase(),

            attendeeName: item.attendee.name,
            attendeeEmail: item.attendee.email.toLowerCase(),

            purchaserName: metadata.fullName || customer.name || "Guest",
            purchaserEmail: customer.email.toLowerCase(),

            isBuyer: item.attendee.isBuyer || false,
            organizer: eventDoc.organizer,

            qr: item.qrBase64,
            status: "success",
            used: false,

            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });

      /* =========================
         WALLET LEDGER
      ========================== */
      await db.collection('wallet_transactions').add({
        reference,
        eventId: metadata.eventId,
        eventName: eventDoc.name,
        organizerId,
        grossAmount: paidAmount,
        platformFee,
        organizerAmount,
        type: 'ticket_sale',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      })

      await db.collection('notifications').add({
        type: 'ticket_purchase',
        title: '🎫 New Tickets Sold',
        message: `${metadata.fullName || 'Someone'} bought ${ticketQty} ticket(s) for ${eventDoc.name}`,
        userId: organizerId,
        actorId: customer.email,
        eventId: metadata.eventId,
        location: eventDoc.location || 'TBA',
        amount: paidAmount,
        reference: reference,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      })

      // Send emails with QR codes to all attendees (non-blocking)
      setImmediate(async () => {
        for (const { ticketId, attendee } of ticketIds) {
          try {
            const ticketSnap = await db.collection("tickets").doc(ticketId).get();
            if (!ticketSnap.exists) continue;

            const ticket = ticketSnap.data();

            const emailPayload = new Brevo.SendSmtpEmail();
            emailPayload.subject = `🎫 Your Ticket for ${eventDoc.name}`;
            emailPayload.sender = {
              name: "Airticks Events",
              email: process.env.EMAIL_FROM,
            };

            emailPayload.to = [
              {
                email: ticket.email,
                name: ticket.buyerName,
              },
            ];

            emailPayload.attachment = [
              {
                name: "ticket-qr.png",
                content: ticket.qr,
              },
            ];

            const intro = ticket.isBuyer
              ? `
                <p>Thank you for purchasing your ticket${ticketQty > 1 ? "s" : ""} for <b>${eventDoc.name}</b>.</p>
                <p>Your personal ticket is attached below.</p>
              `
              : `
                <p><strong>${metadata.fullName}</strong> has purchased this ticket for you to attend <b>${eventDoc.name}</b>.</p>
                <p>This ticket is registered in your name and the QR code below is for your entry only.</p>
              `;

            emailPayload.htmlContent = `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;border:1px solid #eee;border-radius:12px;">

                <h2 style="text-align:center;">🎟 Your Ticket is Ready!</h2>

                <p>Hello <strong>${ticket.buyerName}</strong>,</p>

                ${intro}

                <div style="text-align:center;margin:20px 0;">
                  <img
                    src="data:image/png;base64,${ticket.qr}"
                    width="250"
                    style="border:2px solid #ff8c00;padding:10px;border-radius:8px;"
                  />
                </div>

                <table style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td><strong>Attendee</strong></td>
                    <td>${ticket.buyerName}</td>
                  </tr>

                  ${
                    !ticket.isBuyer
                      ? `
                      <tr>
                        <td><strong>Purchased By</strong></td>
                        <td>${metadata.fullName}</td>
                      </tr>
                    `
                      : ""
                  }

                  <tr>
                    <td><strong>Event</strong></td>
                    <td>${eventDoc.name}</td>
                  </tr>

                  <tr>
                    <td><strong>Location</strong></td>
                    <td>${ticket.location}</td>
                  </tr>

                  <tr>
                    <td><strong>Ticket Reference</strong></td>
                    <td>${ticketId}</td>
                  </tr>
                </table>

                <p style="margin-top:20px;font-size:12px;color:#777;text-align:center;">
                  ⏰ Please arrive at least 15 minutes before the event starts and present this QR code at the entrance.
                </p>

              </div>
            `;

            await emailApi.sendTransacEmail(emailPayload);

            console.log(`📧 Ticket email sent to ${ticket.email}`);
          } catch (emailErr) {
            console.error(
              "❌ Error sending ticket email to",
              attendee.email,
              emailErr
            );
          }
        }
      });

      console.log(`✅ Created ${attendeesList.length} individual ticket(s) with QR codes`)
    }

    return res.sendStatus(200)
  } catch (err) {
    console.error('❌ PAYSTACK WEBHOOK ERROR:', err)
    return res.sendStatus(500)
  }
})



app.post("/api/tickets/verify", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = await admin.auth().verifyIdToken(token);

    const scannerDoc = await db
      .collection("users")
      .doc(decoded.uid)
      .get();

    if (!scannerDoc.exists) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    const scanner = scannerDoc.data();

    if (!scanner.isAdmin && scanner.accountType !== "organization") {
      return res.status(403).json({
        error: "Only organizers and admins can verify tickets.",
      });
    }

    const { ticketId } = req.body;

    const ticketRef = db.collection("tickets").doc(ticketId);

    const ticketDoc = await ticketRef.get();

    if (!ticketDoc.exists) {
      return res.status(404).json({
        error: "Ticket not found.",
      });
    }

    const ticket = ticketDoc.data();

    if (ticket.used) {
      return res.status(409).json({
        error: "Ticket already used.",
        buyerName: ticket.buyerName,
        eventName: ticket.eventName,
      });
    }

    await ticketRef.update({
      used: true,
      scannedAt: admin.firestore.FieldValue.serverTimestamp(),
      scannedBy: decoded.uid,
      scannedByName:
        scanner.fullName ||
        scanner.displayName ||
        scanner.name ||
        "Admin",
    });

    res.json({
      success: true,
      attendeeName: ticket.attendeeName,
      purchaserName: ticket.purchaserName,
      eventName: ticket.eventName,
      ticketType: ticket.ticketType,
      ticketNumber: ticket.ticketNumber,
      used: ticket.used,
      scannedByName: ticket.scannedByName || null,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Verification failed.",
    });
  }
});

app.get("/api/tickets/:ticketId", async (req, res) => {
  try {
    const { ticketId } = req.params;

    const ticketDoc = await db
      .collection("tickets")
      .doc(ticketId)
      .get();

    if (!ticketDoc.exists) {
      return res.status(404).json({
        error: "Ticket not found.",
      });
    }

    const ticket = ticketDoc.data();

    res.json({
      attendeeName: ticket.attendeeName,
      purchaserName: ticket.purchaserName,
      eventName: ticket.eventName,
      ticketType: ticket.ticketType,
      ticketNumber: ticket.ticketNumber,
      used: ticket.used,
      scannedByName: ticket.scannedByName || null,
      scannedAt: ticket.scannedAt
        ? ticket.scannedAt.toDate()
        : null,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Server error.",
    });
  }
});

/* ============================================================
   FETCH PAYSTACK SETTLEMENTS (BANK PAID STATUS)
============================================================ */
app.get('/api/paystack/settlements', authenticate, async (req, res) => {
  try {
    // 🔐 Optional: restrict to admin only
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin only' })
    }

    // 1️⃣ Fetch settlements from Paystack
    const response = await fetch('https://api.paystack.co/settlement', {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    })

    const result = await response.json()
    if (!result.status) {
      return res.status(400).json({ error: result.message })
    }

    const processed = []

    // 2️⃣ Process each settlement
    for (const settlement of result.data) {
      // Only confirmed bank payouts
      if (settlement.status !== 'success' || !settlement.paid_at) continue

      const subCode = settlement.subaccount?.subaccount_code
      if (!subCode) continue

      const settlementRef = settlement.id.toString()
      const settlementAmount = settlement.total_amount / 100 // kobo → naira
      const paidAt = new Date(settlement.paid_at)

      // 3️⃣ Prevent duplicate settlement processing
      const alreadyProcessed = await db
        .collection('wallet_transactions')
        .where('type', '==', 'settlement')
        .where('reference', '==', settlementRef)
        .limit(1)
        .get()

      if (!alreadyProcessed.empty) continue

      // 4️⃣ Map subaccount → organizer
      const subSnap = await db.collection('subaccounts').doc(subCode).get()
      if (!subSnap.exists) continue

      const organizerId = subSnap.data().organizerId
      const walletRef = db.collection('wallets').doc(organizerId)

      // 5️⃣ Atomic settlement transaction
      await db.runTransaction(async tx => {
        const walletSnap = await tx.get(walletRef)
        const wallet = walletSnap.data() || {}

        const pendingBalance = wallet.pendingBalance || 0
        const settledBalance = wallet.settledBalance || 0

        // Never settle more than what is pending
        const amountToSettle = Math.min(pendingBalance, settlementAmount)

        // Update wallet balances + PAID status
        tx.set(
          walletRef,
          {
            pendingBalance: pendingBalance - amountToSettle,
            settledBalance: settledBalance + amountToSettle,
            lastPaidAt: admin.firestore.Timestamp.fromDate(paidAt),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        // Ledger (source of truth)
        tx.set(db.collection('wallet_transactions').doc(), {
          organizerId,
          reference: settlementRef,
          amount: amountToSettle,
          grossAmount: settlementAmount,
          type: 'settlement',
          status: 'paid',
          source: 'paystack',
          paidAt,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        })
      })

      processed.push({
        organizerId,
        amount: settlementAmount,
        paidAt
      })

      await db.collection('notifications').add({
        type: 'settlement',
        title: '💰 Settlement Received',
        message: `₦${settlementAmount.toLocaleString()} has been settled to your bank`,
        userId: organizerId,
        amount: settlementAmount, // <-- FIXED Variable
        reference: settlementRef, // <-- FIXED Variable
        link: '/dashboard/organization/wallet',
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      })
    }

    // 6️⃣ Response
    return res.json({
      success: true,
      processedCount: processed.length,
      processed
    })
  } catch (err) {
    console.error('❌ Settlement sync error:', err)
    res.status(500).json({ error: 'Failed to sync settlements' })
  }
})

app.post('/api/admin/withdraw', authenticate, async (req, res) => {
  // 1. Safety Check: Is the user actually an admin?
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Unauthorized: Admin access only' })
  }

  const { amount } = req.body
  if (!amount || amount <= 0)
    return res.status(400).json({ error: 'Invalid amount' })

  try {
    const platformWalletRef = db.collection('wallets').doc('platform')

    await db.runTransaction(async tx => {
      const platformSnap = await tx.get(platformWalletRef)
      const currentBalance = platformSnap.data()?.balance || 0

      // 2. Double-check balance on the server (Security best practice)
      if (currentBalance < amount) {
        throw new Error('Insufficient platform balance')
      }

      // 3. Subtract from Platform Wallet
      tx.update(platformWalletRef, {
        balance: admin.firestore.FieldValue.increment(-amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      })

      // 4. Log the transaction for your accounting
      const ledgerRef = db.collection('wallet_transactions').doc()
      tx.set(ledgerRef, {
        amount,
        type: 'platform_withdrawal',
        adminId: req.user.uid,
        status: 'success',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      })
    })

    await db.collection('notifications').add({
      type: 'platform_withdrawal',
      title: '🏦 Platform Withdrawal',
      message: `₦${amount.toLocaleString()} withdrawn by admin`,
      userId: 'platform',
      adminId: req.user.uid,
      link: '/dashboard/wallet',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    })

    res.json({ success: true, message: 'Withdrawal recorded successfully' })
  } catch (err) {
    console.error('Platform Withdrawal Error:', err)
    res
      .status(500)
      .json({ error: err.message || 'Failed to process withdrawal' })
  }
})

app.get('/api/withdrawals', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid
    const isAdmin = req.user.isAdmin

    // 1️⃣ Withdraw requests (pending / paid)
    let reqQuery = db.collection('withdraw_requests')
    if (!isAdmin) {
      reqQuery = reqQuery.where('organizerId', '==', uid)
    }

    const reqSnap = await reqQuery.get()
    const requests = reqSnap.docs.map(doc => ({
      id: doc.id,
      amount: doc.data().amount,
      status: doc.data().status, // pending | paid
      reference: doc.data().reference || null,
      createdAt: doc.data().createdAt?.toDate()
    }))

    // 2️⃣ Wallet ledger (success)
    let ledgerQuery = db
      .collection('wallet_transactions')
      .where('type', '==', 'withdrawal')

    if (!isAdmin) {
      ledgerQuery = ledgerQuery.where('organizerId', '==', uid)
    }

    const ledgerSnap = await ledgerQuery.get()
    const ledger = ledgerSnap.docs.map(doc => ({
      id: doc.id,
      amount: doc.data().amount,
      status: 'success',
      reference: doc.data().reference,
      createdAt: doc.data().createdAt?.toDate()
    }))

    // 3️⃣ Merge & sort
    const combined = [...requests, ...ledger].sort(
      (a, b) => b.createdAt - a.createdAt
    )

    res.json(combined)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch withdrawals' })
  }
})

app.post('/api/payout-history', authenticate, async (req, res) => {
  try {
    const { organizerId, startDate, endDate } = req.body
    if (req.user.uid !== organizerId && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    let query = db
      .collection('wallet_transactions')
      .where('organizerId', '==', organizerId)
      .where('type', '==', 'settlement')
    if (startDate) {
      query = query.where(
        'createdAt',
        '>=',
        admin.firestore.Timestamp.fromDate(new Date(startDate))
      )
    }
    if (endDate) {
      query = query.where(
        'createdAt',
        '<=',
        admin.firestore.Timestamp.fromDate(new Date(endDate))
      )
    }
    const snap = await query.orderBy('createdAt', 'desc').get()
    const history = snap.docs.map(doc => ({
      id: doc.id,
      amount: doc.data().amount,
      reference: doc.data().reference,
      createdAt: doc.data().createdAt?.toDate()
    }))
    res.json(history)
  } catch (err) {
    console.error('Payout history error:', err)
    res.status(500).json({ error: 'Failed to fetch payout history' })
  }
})

/* =======================
   SERVER START
======================= */
const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`))
