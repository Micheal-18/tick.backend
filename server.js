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
    const { name, category, location, description } = req.body;

    const prompt = `
You are an event marketing expert.
Improve this event description.

Event Name: ${name}
Category: ${category}
Location: ${location}

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
- Keep it under 100 words.
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
    const { name, email, eventId, ticketLabel, ticketNumber, userId } = req.body

    if (!email || !eventId || !ticketLabel) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const qty = Number(ticketNumber)
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Invalid ticket quantity' })
    }

    /* ===============================
       2. FETCH EVENT
    =============================== */
    const eventSnap = await db.collection('events').doc(eventId).get()
    if (!eventSnap.exists) {
      return res.status(404).json({ error: 'Event not found' })
    }

    const event = eventSnap.data()

    /* ===============================
       3. FIND TICKET
    =============================== */
    const ticket = event.price?.find(t => t.label === ticketLabel)
    if (!ticket) {
      return res.status(400).json({ error: 'Ticket type not found on this event' })
    }

    const ticketPrice = Number(ticket.amount)
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
      const ticketRef = db.collection('tickets').doc(freeReference)

      // 1. Atomic transaction to issue ticket and update analytics counters
      await db.runTransaction(async tx => {
        tx.set(eventSnap.ref, {
          ticketSold: admin.firestore.FieldValue.increment(qty),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true })

        tx.set(ticketRef, {
          reference: freeReference,
          organizerId,
          userId: userId || null,
          eventId,
          eventName: event.name,
          ticketNumber: qty,
          ticketType: ticketLabel,
          location: event.location || 'TBA',
          amount: 0,
          status: 'success',
          used: false,
          email: email.toLowerCase().trim(),
          buyerName: name || 'Guest',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        })
      })

      // 2. Generate the visual pass QR asset code
      const qrUrl = `${process.env.FRONTEND_URL}/ticket/${ticketRef.id}`;
        
      const qrData = await QRCode.toDataURL(qrUrl, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: "M",
      });

      const qrBase64 = qrData.replace(/^data:image\/png;base64,/, '')
      await ticketRef.update({ qr: qrBase64 })

      // 3. Dispatch the ticket via Brevo immediately (Non-blocking worker thread)
      setImmediate(async () => {
        try {
          const emailPayload = new Brevo.SendSmtpEmail()
          emailPayload.subject = `🎫 Your Free Pass Confirmation: ${event.name}`
          emailPayload.sender = { name: 'Airticks Events', email: process.env.EMAIL_FROM }
          emailPayload.to = [{ email: email.toLowerCase().trim(), name: name || 'Guest' }]
          emailPayload.attachment = [{ name: 'ticket-qr.png', content: qrBase64 }]
          emailPayload.htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; padding:20px; border:1px solid #eee; border-radius:12px;">
              <h2 style="text-align:center; color:#16a34a;">🎉 Free Registration Confirmed!</h2>
              <p>Hello ${name || 'Guest'},</p>
              <p>Your free ticket pass for <b>${event.name}</b> is confirmed.</p>
              <table style="width:100%; margin:16px 0;">
                <tr><td><b>Ticket Reference</b></td><td>${freeReference}</td></tr>
                <tr><td><b>Quantity Passed</b></td><td>${qty} Ticket(s)</td></tr>
                <tr><td><b>Ticket Tier</b></td><td>${ticketLabel}</td></tr>
                <tr><td><b>Price</b></td><td style="color:green; font-weight:bold;">FREE</td></tr>
              </table>
              <p style="text-align:center;">
                <img src="data:image/png;base64,${qrBase64}" width="200" />
              </p>
              <p style="font-size:12px; color:#777; text-align:center;">
                Present this QR code at the event gate checkpoint layout for entrance access validation.
              </p>
            </div>
          `
          await emailApi.sendTransacEmail(emailPayload)
        } catch (emailErr) {
          console.error('❌ Brevo background worker free ticket email error:', emailErr)
        }
      })

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

    console.log('🧾 Processing Paid Ticket Checkout Routing:', ticketLabel)

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
            ticketLabel,
            ticketNumber: qty,
            platform: 'airticks',
            userId: userId || null,
            fullName: name
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
      const existing = await db
        .collection('tickets')
        .where('reference', '==', reference)
        .limit(1)
        .get()

      if (!existing.empty) return res.sendStatus(200)

      /* =========================
         FETCH EVENT
      ========================== */
      const eventRef = db.collection('events').doc(metadata.eventId)
      const eventSnap = await eventRef.get()
      if (!eventSnap.exists) return res.sendStatus(200)

      const eventDoc = eventSnap.data()
      const organizerId = eventDoc.ownerId

      const platformWalletRef = db.collection('wallets').doc('platform')
      const organizerWalletRef = db.collection('wallets').doc(organizerId)
      const ticketRef = db.collection('tickets').doc(reference)

      const ticketQty = Number(metadata.ticketNumber) || 1

      /* =========================
         FIRESTORE TRANSACTION
      ========================== */
      await db.runTransaction(async tx => {
        const platformSnap = await tx.get(platformWalletRef)
        const organizerSnap = await tx.get(organizerWalletRef)

        // PLATFORM (real money)
        tx.set(
          platformWalletRef,
          {
            balance: (platformSnap.data()?.balance || 0) + platformFee,
            totalEarned: (platformSnap.data()?.totalEarned || 0) + platformFee,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        // ORGANIZER (pending only)
        tx.set(
          organizerWalletRef,
          {
            pendingBalance:
              (organizerSnap.data()?.pendingBalance || 0) + organizerAmount,
            totalEarned:
              (organizerSnap.data()?.totalEarned || 0) + organizerAmount,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        // EVENT STATS (NO MONEY)
        tx.set(
          eventRef,
          {
            ticketSold: admin.firestore.FieldValue.increment(
              Number(metadata.ticketNumber)
            ),
            grossRevenue: admin.firestore.FieldValue.increment(paidAmount),
            organizerRevenue:
              admin.firestore.FieldValue.increment(organizerAmount),
            platformRevenue: admin.firestore.FieldValue.increment(platformFee),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        // TICKET
        tx.set(ticketRef, {
          reference,
          organizerId,
          userId: metadata.userId || null,
          eventId: metadata.eventId,
          eventName: eventDoc.name,
          ticketNumber: ticketQty,
          ticketType: metadata.ticketLabel || 'Default Label',
          location: eventDoc.location || 'TBA',
          amount: paidAmount,
          status: 'success',
          used: false,
          email: customer.email,
          buyerName: metadata.fullName || customer.name || 'Guest',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        })
      })

      /* =========================
         QR CODE
      ========================== */
      const qrUrl = `${process.env.FRONTEND_URL}/ticket/${ticketRef.id}`;

      const qrData = await QRCode.toDataURL(qrUrl, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: "M",
      });

      // remove prefix ONCE
      const qrBase64 = qrData.replace(/^data:image\/png;base64,/, '')

      await ticketRef.update({ qr: qrBase64 })

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
  title: '🎫 New Ticket Sold',
  message: `${metadata.fullName || 'Someone'} bought ${ticketQty} ticket(s) for ${eventDoc.name}`,
  userId: organizerId,
  actorId: customer.email,
  eventId: metadata.eventId,
  location: eventDoc.location || 'TBA',
  amount: paidAmount, // Cleaned Nairas decimal number
  reference: reference, // Tied safely to payload reference variable 
  read: false,
  createdAt: admin.firestore.FieldValue.serverTimestamp()
})

      /* =========================
         EMAIL (NON-BLOCKING)
      ========================== */
      setImmediate(async () => {
        try {
          const email = new Brevo.SendSmtpEmail()

          email.subject = '🎫 Your Ticket Confirmation'

          email.sender = {
            name: 'Airticks Event',
            email: process.env.EMAIL_FROM
          }

          email.to = [
            {
              email: customer.email,
              name: metadata.fullName || 'Guest'
            }
          ]

          email.attachment = [
            {
              name: 'ticket-qr.png',
              content: qrBase64
            }
          ]

          email.htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width:600px; margin:auto; padding:20px; border:1px solid #eee; border-radius:12px;">
              <h2 style="text-align:center;">🎉 Ticket Confirmed!</h2>
              <p>Hello ${metadata.fullName || 'Guest'},</p>

              <p>Your ticket for <b>${
                eventDoc.name
              }</b> has been successfully confirmed.</p>

              <table style="width:100%; margin:16px 0;">
                <tr><td><b>Reference</b></td><td>${reference}</td></tr>
                <tr><td><b>Tickets</b></td><td>${
                  metadata.ticketNumber
                }</td></tr>
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
          `

          await emailApi.sendTransacEmail(email)
          console.log('📧 Email sent to', customer.email)
        } catch (err) {
          console.error('❌ Brevo email error:', err?.response?.body || err)
        }
      })
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
      buyerName: ticket.buyerName,
      eventName: ticket.eventName,
      ticketType: ticket.ticketType,
      ticketNumber: ticket.ticketNumber,
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
      buyerName: ticket.buyerName,
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
