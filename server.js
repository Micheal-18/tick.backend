import express from 'express'
import dotenv from 'dotenv'
dotenv.config()
import fetch from 'node-fetch'
import admin from 'firebase-admin'
import cors from 'cors'
import QRCode from 'qrcode'
import Brevo from '@getbrevo/brevo'
import crypto from 'crypto'
import { GoogleGenAI } from '@google/genai'
import axios from 'axios'
import nodemailer from 'nodemailer'

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
})

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

app.post('/api/notifications/create', authenticate, async (req, res) => {
  try {
    const {
      userId,
      userEmail,
      title,
      message,
      link,
      status,
      type,
      senderId,
      senderName
    } = req.body

    if (!userId || !userEmail || !message) {
      return res
        .status(400)
        .json({ error: 'Missing required notification fields' })
    }

    // 1. Create the in-app notification in Firestore
    await db.collection('notifications').add({
      userId,
      title: title || 'New Notification',
      message,
      link: link || null,
      read: false,
      status: status || 'unread', // Defaults to unread, but catches your 'pending'
      type: type || 'general',
      senderId: senderId || null,
      senderName: senderName || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    })

    // 2. Fire off the email via Brevo
    const emailPayload = new Brevo.SendSmtpEmail()
    emailPayload.subject = title || 'New update from AirTicks'
    emailPayload.sender = {
      name: 'AirTicks',
      email: process.env.EMAIL_FROM
    }
    emailPayload.to = [{ email: userEmail }]
    emailPayload.htmlContent = `
      <div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;margin:auto;border:1px solid #eee;border-radius:12px;">
        <h2 style="color:#16a34a;">${title || 'Update'}</h2>
        <p>${message}</p>
        ${
          link
            ? `<p><a href="${process.env.FRONTEND_URL}${link}" style="color:#ff8c00;text-decoration:none;font-weight:bold;">View Details &rarr;</a></p>`
            : ''
        }
      </div>
    `

    await emailApi.sendTransacEmail(emailPayload)

    res.status(200).json({ success: true })
  } catch (error) {
    console.error('Notification Error:', error)
    res.status(500).json({ error: 'Failed to process notification' })
  }
})

app.post('/send-message', async (req, res) => {
  const { name, email, message } = req.body

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'All fields are required.' })
  }

  try {
    // Configure Brevo SMTP
    const transporter = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_SMTP_KEY
      }
    })

    // Message details
    const mailOptions = {
      from: `"Airticks Contact" <${process.env.EMAIL_FROM}>`,
      to: 'michaeleleke259@gmail.com', // 👈 your real inbox
      subject: `New message from ${name}`,
      html: `
        <h2>New Contact Message</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `
    }

    await transporter.sendMail(mailOptions)
    console.log('✅ Email sent to your inbox')
    res
      .status(200)
      .json({ success: true, message: 'Message sent successfully!' })
  } catch (error) {
    console.error('❌ Error sending email:', error)
    res.status(500).json({ error: 'Failed to send message.' })
  }
})

app.post('/api/description', async (req, res) => {
  try {
    const { name, category, venue, description } = req.body

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
`

    // FIX: Using the correct, globally available text model
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    })

    res.json({
      description: response.text
    })
  } catch (err) {
    console.error('Description Generation Error:', err)
    res.status(500).json({
      error: 'Failed to generate description.'
    })
  }
})

// Endpoint 2: Generate Event Flyer Background
app.post('/api/flyer', async (req, res) => {
  try {
    const { name, category, description, location, organizer } = req.body

    // Let Gemini improve the prompt
    const promptResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
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
`
    })

    const prompt =
      typeof promptResponse.text === 'function'
        ? promptResponse.text()
        : promptResponse.text

    // Encode the prompt
    const encodedPrompt = encodeURIComponent(prompt)

    // Pollinations image URL
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=1024&model=flux&nologo=true`
    // Download the generated image
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer'
    })

    // Convert image to base64
    const base64 = Buffer.from(imageResponse.data, 'binary').toString('base64')

    res.json({
      image: `data:image/png;base64,${base64}`
    })
  } catch (err) {
    console.error(err)

    res.status(500).json({
      error: 'Failed to generate flyer.'
    })
  }
})

app.get('/api/banks', async (req, res) => {
  try {
    const response = await fetch(
      'https://api.paystack.co/bank?country=nigeria',
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    )

    const data = await response.json()

    if (!data.status) {
      return res.status(400).json({
        error: data.message
      })
    }

    res.json(data.data)
  } catch (err) {
    console.error(err)
    res.status(500).json({
      error: 'Unable to fetch banks'
    })
  }
})

app.post('/api/resolve-account', async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body

    if (!accountNumber || !bankCode) {
      return res.status(400).json({
        error: 'Missing account details'
      })
    }

    const response = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    )

    const data = await response.json()

    if (!data.status) {
      return res.status(400).json({
        error: data.message
      })
    }

    res.json({
      accountName: data.data.account_name,
      accountNumber: data.data.account_number,
      bankId: data.data.bank_id
    })
  } catch (err) {
    console.error(err)

    res.status(500).json({
      error: 'Unable to resolve account'
    })
  }
})

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
      ticketCurrency,
      ticketQuantity,
      userId,
      attendees = [],
      ticketItems = []
    } = req.body

    if (
      typeof email !== 'string' ||
      !email.trim() ||
      typeof eventId !== 'string' ||
      !eventId
    ) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const requestedQuantity = Number(ticketQuantity)
    if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
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
    console.log(event)

    /* ===============================
       3. FIND TICKET
    =============================== */
    const ticketList = Array.isArray(event.tickets)
      ? event.tickets
      : Array.isArray(event.price)
      ? event.price
      : []

    const hasTicketItems = Array.isArray(ticketItems) && ticketItems.length > 0
    const requestedItems = hasTicketItems
      ? ticketItems
      : [{ ticketId, quantity: requestedQuantity, attendees }]
    const normalizedItems = []

    for (const item of requestedItems) {
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ error: 'Invalid ticket item' })
      }

      const itemQuantity = Number(item.quantity ?? item.ticketQuantity)
      if (!item.ticketId || !Number.isInteger(itemQuantity) || itemQuantity <= 0) {
        return res.status(400).json({ error: 'Invalid ticket item' })
      }

      const ticket = ticketList.find(t => t.id === item.ticketId)
      if (!ticket) {
        return res.status(400).json({ error: 'Ticket type not found' })
      }

      const price = Number(ticket.price ?? 0)
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'Invalid ticket price configuration' })
      }

      if (itemQuantity > 10) {
        return res.status(400).json({
          error: `Maximum 10 ${ticket.name} ticket(s) per purchase.`
        })
      }

      const remaining = ticket.quantity == null
        ? Infinity
        : Number(ticket.quantity) - Number(ticket.sold || 0)
      if (
        !Number.isFinite(remaining) &&
        ticket.quantity != null
      ) {
        return res.status(400).json({
          error: `Invalid inventory configuration for ${ticket.name}.`
        })
      }
      if (remaining <= 0 || itemQuantity > remaining) {
        return res.status(400).json({
          error: remaining <= 0
            ? `${ticket.name} is sold out.`
            : `Only ${remaining} ${ticket.name} ticket(s) remaining.`
        })
      }

      if (new Set(normalizedItems.map(item => item.ticketId)).size !== normalizedItems.length) {
        return res.status(400).json({ error: 'Duplicate ticket types are not allowed.' })
      }

      normalizedItems.push({
        ticket,
        ticketId: ticket.id,
        ticketName: ticket.name,
        ticketType: ticket.type || (price === 0 ? 'free' : 'paid'),
        ticketCurrency: ticket.currency || ticketCurrency || 'NGN',
        ticketPrice: price,
        quantity: itemQuantity,
        attendees: Array.isArray(item.attendees)
          ? item.attendees
          : hasTicketItems
            ? []
            : Array.isArray(attendees)
              ? attendees
              : []
      })
    }

    const qty = normalizedItems.reduce((total, item) => total + item.quantity, 0)
    if (qty !== requestedQuantity) {
      return res.status(400).json({
        error: 'Ticket item quantities do not match the requested quantity.'
      })
    }

    const currencies = [...new Set(normalizedItems.map(item => item.ticketCurrency))]
    if (currencies.length > 1) {
      return res.status(400).json({
        error: 'Tickets with different currencies must be purchased separately.'
      })
    }

    const attendeesList = normalizedItems.flatMap(item =>
      item.attendees.map(attendee => ({
        ...attendee,
        ticketId: item.ticketId,
        ticketName: item.ticketName,
        ticketType: item.ticketType,
        ticketCurrency: item.ticketCurrency,
        ticketPrice: item.ticketPrice,
        maxPerPerson: item.ticket.maxPerPerson
      }))
    )

    if (!hasTicketItems && attendeesList.length === 0 && qty === 1) {
      const item = normalizedItems[0]
      attendeesList.push({
        name: name || 'Guest',
        email: email.toLowerCase(),
        isBuyer: true,
        ticketId: item.ticketId,
        ticketName: item.ticketName,
        ticketType: item.ticketType,
        ticketCurrency: item.ticketCurrency,
        ticketPrice: item.ticketPrice,
        maxPerPerson: item.ticket.maxPerPerson
      })
    }

    if (attendeesList.length !== qty) {
      return res.status(400).json({
        error: 'Attendee count does not match ticket quantity.'
      })
    }

    const validAttendees = attendeesList.every(
      attendee =>
        typeof attendee?.name === 'string' &&
        attendee.name.trim() &&
        typeof attendee?.email === 'string' &&
        attendee.email.trim() &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendee.email.trim())
    )
    if (!validAttendees) {
      return res.status(400).json({
        error: 'A valid name and email are required for every attendee.'
      })
    }

    const emails = attendeesList.map(a => a.email.trim().toLowerCase())
    if (new Set(emails).size !== emails.length) {
      return res.status(400).json({
        error: 'Duplicate attendee emails are not allowed.'
      })
    }

    const totalAmount = event.isFree === true
      ? 0
      : normalizedItems.reduce(
          (total, item) => total + item.ticketPrice * item.quantity,
          0
        )
    if (
      event.isFree !== true &&
      normalizedItems.some(item => item.ticketPrice === 0) &&
      normalizedItems.some(item => item.ticketPrice > 0)
    ) {
      return res.status(400).json({
        error: 'Free and paid tickets must be purchased separately.'
      })
    }
    const primaryItem = normalizedItems[0]

    /* ============================================================
       ⚡ SHORT-CIRCUIT ROUTE FOR FREE TICKETS (0 NAIRA / 0 DOLLARS)
    ============================================================ */
    if (totalAmount === 0 || event.isFree === true) {
      const freeReference = `FREE-${Date.now()}-${crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase()}`
      const organizerId = event.ownerId
      const ticketIds = []

      const ticketField = Array.isArray(event.tickets) ? 'tickets' : 'price'
      const itemQuantities = new Map(
        normalizedItems.map(item => [item.ticketId, item.quantity])
      )

      const updatedTickets = ticketList.map(t => {
        const itemQuantity = itemQuantities.get(t.id)
        if (!itemQuantity) return t

        return {
          ...t,
          sold: (t.sold || 0) + itemQuantity
        }
      })
      await db.runTransaction(async tx => {
        const currentCount = event.attendeeCount || 0

        tx.set(
          eventSnap.ref,
          {
            attendeeCount: currentCount + qty,
            [ticketField]: updatedTickets,
            ticketSold: admin.firestore.FieldValue.increment(qty),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        for (const [index, attendee] of attendeesList.entries()) {
          const ticketRef = db.collection('tickets').doc()
          const ticketId = ticketRef.id

          const qrUrl = `${process.env.FRONTEND_URL}/ticket/${ticketId}`
          const qrData = await QRCode.toDataURL(qrUrl, {
            width: 320,
            margin: 1,
            errorCorrectionLevel: 'M'
          })

          const qrBase64 = qrData.replace(/^data:image\/png;base64,/, '')

          const attendeeNumber = currentCount + index + 1

          tx.set(ticketRef, {
            ticketId,
            reference: freeReference,
            parentReference: freeReference,
            ticketIndex: index,
            organizerId,
            userId: userId || null,
            eventId,
            eventName: event.name,
            ticketType: attendee.ticketName,
            currency: attendee.ticketCurrency,
            location: event.venue.name || 'TBA',
            map: event.venue.map,
            amount: event.isFree === true ? 0 : attendee.ticketPrice,
            buyerName: attendee.name.trim(),
            email: attendee.email.trim().toLowerCase(),

            attendeeName: attendee.name.trim(),
            attendeeEmail: attendee.email.trim().toLowerCase(),
            attendeeNumber,

            purchaserName: name,
            purchaserEmail: email.toLowerCase(),
            totalTickets: qty,
            ticketQuantity: normalizedItems.find(
              item => item.ticketId === attendee.ticketId
            ).quantity,
            maxPerPerson: attendee.maxPerPerson,
            isBuyer: attendee.isBuyer === true,
            qr: qrBase64,
            status: 'success',
            used: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          })

          ticketIds.push({
            ticketId,
            attendee
          })
        }
      })
      // 3. Dispatch the ticket via Brevo immediately (Non-blocking worker thread)
      setImmediate(async () => {
        for (const { ticketId, attendee } of ticketIds) {
          try {
            const ticketSnap = await db
              .collection('tickets')
              .doc(ticketId)
              .get()

            if (!ticketSnap.exists) continue

            const ticket = ticketSnap.data()

            const emailPayload = new Brevo.SendSmtpEmail()

            emailPayload.subject = `🧩 Congratulations, You're ${event.name} certified `

            emailPayload.sender = {
              name: 'Airticks Events',
              email: process.env.EMAIL_FROM
            }

            emailPayload.to = [
              {
                email: ticket.email,
                name: ticket.buyerName
              }
            ]

            emailPayload.attachment = [
              {
                name: 'ticket-qr.png',
                content: ticket.qr
              }
            ]

            const intro = ticket.isBuyer
              ? `
                  <p>Your free ticket to <b>${event.name}</b> experience is ready.</p>

                  <p>Your personal ticket is attached below.</p>
                  <p>Ticket Number: ${ticket.attendeeNumber} </p>
                `
              : `
                  <p><strong>${ticket.purchaserName}</strong> has registered you for <b>${event.name}</b>.</p>
                  <p>Ticket Number: ${ticket.attendeeNumber} </p>
                  
                  <p>This QR code belongs only to you.</p>
                `

            emailPayload.htmlContent = `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;border:1px solid #eee;border-radius:12px;">

              <h2 style="text-align:center;color:#16a34a;">
                🦅 Free Ticket Confirmed
              </h2>

              <p>Hello <strong>${ticket.buyerName}</strong>,</p>

              ${intro}

              <div style="text-align:center;margin:20px 0;">
                  <img src="data:image/png;base64,${ticket.qr}" width="220"/>
              </div>

              <table style="width:100%;border-collapse:collapse;">

                  <tr>
                      <td><strong>Event:</strong></td>
                      <td>${event.name}</td>
                  </tr>

                  <tr>
                      <td><strong>Ticket Type:</strong></td>
                      <td>${ticket.ticketType}</td>
                  </tr>

                  <tr>
                      <td><strong>Direction:</strong></td>
                      <td>${ticket.map}</td>
                  </tr>

                  <tr>
                      <td><strong>Price:</strong></td>
                      <td style="color:green;font-weight:bold;">FREE</td>
                  </tr>

                  <tr>
                      <td><strong>Reference:</strong></td>
                      <td>${ticketId}</td>
                  </tr>

              </table>

              <p style="font-size:12px;color:#777;text-align:center;margin-top:20px;">
                  Please present this QR code at the event entrance.
              </p>

            </div>
            `

            await emailApi.sendTransacEmail(emailPayload)

            console.log('✅ Free ticket email sent:', ticket.email)
          } catch (err) {
            console.error('❌ Free ticket email error:', attendee.email, err)
          }
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
      return res
        .status(400)
        .json({
          error: 'Organizer payout routing parameters are unconfigured.'
        })
    }

    const amountInKobo = Math.round(totalAmount * 100)
    if (amountInKobo < 100) {
      return res
        .status(400)
        .json({ error: 'Amount too low for Paystack channels processing.' })
    }

    console.log('🧾 Processing Paid Ticket Checkout Routing:', primaryItem.ticketName)

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
            ticketId: primaryItem.ticketId,
            ticketName: primaryItem.ticketName,
            ticketPrice: primaryItem.ticketPrice,
            ticketCurrency: primaryItem.ticketCurrency,
            ticketNumber: qty,
            platform: 'airticks',
            userId: userId || null,
            fullName: name,
            attendees: attendeesList
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
    return res
      .status(500)
      .json({ error: 'Payment initialization sequence faulted.' })
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
      const rawAttendees =
        Array.isArray(metadata.attendees) && metadata.attendees.length > 0
          ? metadata.attendees
          : [
              {
                name: metadata.fullName || customer.name || 'Guest',
                email: customer.email,
                isBuyer: true
              }
            ]

      const attendeesList = rawAttendees.map(attendee => ({
        ...attendee,
        ticketId: attendee.ticketId || metadata.ticketId,
        ticketName: attendee.ticketName || metadata.ticketName,
        ticketType: attendee.ticketType || metadata.ticketType,
        ticketCurrency: attendee.ticketCurrency || metadata.ticketCurrency,
        ticketPrice: attendee.ticketPrice ?? metadata.ticketPrice
      }))

      if (attendeesList.length !== ticketQty) {
        console.error('❌ Ticket quantity does not match attendee metadata')
        return res.sendStatus(200)
      }

      const ticketCounts = attendeesList.reduce((counts, attendee) => {
        counts.set(attendee.ticketId, (counts.get(attendee.ticketId) || 0) + 1)
        return counts
      }, new Map())

      const ticketList = Array.isArray(eventDoc.tickets)
        ? eventDoc.tickets
        : Array.isArray(eventDoc.price)
          ? eventDoc.price
          : []
      const knownTicketIds = new Set(ticketList.map(item => item.id))
      if ([...ticketCounts.keys()].some(id => !knownTicketIds.has(id))) {
        console.error('❌ Unknown ticket type in payment metadata')
        return res.sendStatus(200)
      }

      const emails = attendeesList.map(a => a.email.toLowerCase())

      if (new Set(emails).size !== emails.length) {
        return res.status(400).json({
          error: 'Duplicate attendee emails are not allowed.'
        })
      }

      /* ============================================================
         ⚡ PERFORMANCE OPTIMIZATION: PRE-GENERATE TICKET IDS & QR CODES
         (Keeps the Firestore Transaction lightweight and deterministic)
      ============================================================ */
      const preparedTickets = []
      const ticketIds = []

      for (const [index, attendee] of attendeesList.entries()) {
        const ticketRef = db.collection('tickets').doc()
        const ticketId = ticketRef.id

        const qrUrl = `${process.env.FRONTEND_URL}/ticket/${ticketId}`
        const qrData = await QRCode.toDataURL(qrUrl, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: 'M'
        })
        const qrBase64 = qrData.replace(/^data:image\/png;base64,/, '')

        preparedTickets.push({
          ticketRef,
          ticketId,
          index,
          attendee,
          qrBase64
        })

        ticketIds.push({ ticketId, attendee })
      }

      /* ============================================================
         💼 TRANSACTION WORKFLOW (WALLETS, COUNT, & DATA WRITE)
      ============================================================ */
      await db.runTransaction(async tx => {
        const platformWalletRef = db.collection('wallets').doc('platform')
        const organizerWalletRef = db.collection('wallets').doc(organizerId)

        const currentCount = eventDoc.attendeeCount || 0

        // Update Wallet Metrics
        tx.set(
          platformWalletRef,
          {
            balance: admin.firestore.FieldValue.increment(platformFee),
            totalRevenue: admin.firestore.FieldValue.increment(platformFee),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        tx.set(
          organizerWalletRef,
          {
            pendingBalance:
              admin.firestore.FieldValue.increment(organizerAmount),
            totalEarnings:
              admin.firestore.FieldValue.increment(organizerAmount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        // Update Event Ticket metrics
        tx.set(
          eventRef,
          {
            ticketSold: admin.firestore.FieldValue.increment(ticketQty),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )

        const ticketField = Array.isArray(eventDoc.tickets) ? 'tickets' : 'price'

        const updatedTickets = (eventDoc[ticketField] || []).map(t => {
          const itemQuantity = ticketCounts.get(t.id)
          if (!itemQuantity) return t

          return {
            ...t,
            sold: (t.sold || 0) + itemQuantity
          }
        })

        tx.update(eventRef, {
          attendeeCount: currentCount + ticketQty,
          [ticketField]: updatedTickets
        })

        // Write batch tickets
        for (const item of preparedTickets) {
          const attendeeNumber = currentCount + item.index + 1

          tx.set(item.ticketRef, {
            ticketId: item.ticketId,
            reference,
            parentReference: reference,
            ticketIndex: item.index,

            organizerId,
            userId: metadata.userId || null,

            eventId: metadata.eventId,
            eventName: eventDoc.name,
            ticketType: item.attendee.ticketName,
            ticketQuantity: ticketCounts.get(item.attendee.ticketId),
            totalTickets: attendeesList.length,
            location: eventDoc.venue.name || 'TBA',
            map: eventDoc.venue.map,
            currency: item.attendee.ticketCurrency,

            amount: Number(item.attendee.ticketPrice || 0),

            // Unified field naming matching frontend lookups & verification schemas
            buyerName: item.attendee.name.trim(),
            email: item.attendee.email.trim().toLowerCase(),

            attendeeName: item.attendee.name.trim(),
            attendeeEmail: item.attendee.email.trim().toLowerCase(),
            attendeeNumber,

            purchaserName: metadata.fullName || customer.name || 'Guest',
            purchaserEmail: customer.email.toLowerCase(),

            isBuyer: item.attendee.isBuyer === true,
            organizer: eventDoc.organizer,

            qr: item.qrBase64,
            status: 'success',
            used: false,

            createdAt: admin.firestore.FieldValue.serverTimestamp()
          })
        }
      })

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
        message: `${
          metadata.fullName || 'Someone'
        } bought ${ticketQty} ticket(s) for ${eventDoc.name}`,
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
            const ticketSnap = await db
              .collection('tickets')
              .doc(ticketId)
              .get()
            if (!ticketSnap.exists) continue

            const ticket = ticketSnap.data()

            const emailPayload = new Brevo.SendSmtpEmail()
            emailPayload.subject = `🦅 Congratulations, You're ${eventDoc.name} certified!`
            emailPayload.sender = {
              name: 'Airticks Events',
              email: process.env.EMAIL_FROM
            }

            emailPayload.to = [
              {
                email: ticket.email,
                name: ticket.buyerName
              }
            ]

            emailPayload.attachment = [
              {
                name: 'ticket-qr.png',
                content: ticket.qr
              }
            ]

            const intro = ticket.isBuyer
              ? `
                <p>Thank you for purchasing your ticket${
                  ticketQty > 1 ? 's' : ''
                } for <b>${eventDoc.name}</b>.</p>
                <p>Your personal ticket is attached below.</p>
                <p>Ticket No: ${ticket.attendeeNumber}</p>
              `
              : `
                <p><strong>${metadata.fullName}</strong> has purchased this ticket for you to attend <b>${eventDoc.name}</b>.</p>
                <p>This ticket is registered in your name and the QR code below is for your entry only.</p>
              `

            emailPayload.htmlContent = `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;border:1px solid #eee;border-radius:12px;">

                <h2 style="text-align:center;">🦅 Your ticket to the ${
                  eventDoc.name
                } Experience is ready!</h2>

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
                      : ''
                  }

                  <tr>
                    <td><strong>Event:</strong></td>
                    <td>${eventDoc.name}</td>
                  </tr>

                  <tr>
                    <td><strong>Location:</strong></td>
                    <td>${ticket.location}</td>
                  </tr>

                  <tr>
                    <td><strong>Direction:</strong></td>
                    <td>${ticket.map}</td>
                  </tr>

                  <tr>
                  <td><strong>TicketType</strong>
                  <td>${ticket.ticketType}</td>
                  </tr>

                  <tr>
                    <td><strong>Ticket Reference:</strong></td>
                    <td>${ticketId}</td>
                  </tr>
                </table>

                <p style="margin-top:20px;font-size:12px;color:#777;text-align:center;">
                  ⏰ Please arrive at least 15 minutes before the event starts and present this QR code at the entrance.
                </p>

              </div>
            `

            await emailApi.sendTransacEmail(emailPayload)

            console.log(`📧 Ticket email sent to ${ticket.email}`)
          } catch (emailErr) {
            console.error(
              '❌ Error sending ticket email to',
              attendee.email,
              emailErr
            )
          }
        }
      })

      console.log(
        `✅ Created ${attendeesList.length} individual ticket(s) with QR codes`
      )
    }

    return res.sendStatus(200)
  } catch (err) {
    console.error('❌ PAYSTACK WEBHOOK ERROR:', err)
    return res.sendStatus(500)
  }
})


/* =========================================
   ADMIN PROMOTIONAL / GIVEAWAY TICKETS
   Uses existing Firebase Admin, authenticate,
   QRCode, db, and Brevo emailApi.
========================================= */

const escapePromoHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

const sendPromoTicketEmail = async (ticketId, ticket, eventData) => {
  if (!process.env.EMAIL_FROM) {
    throw new Error("EMAIL_FROM is not configured.");
  }

  if (!process.env.BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is not configured.");
  }

  if (!ticket.qr) {
    throw new Error("Ticket QR code is missing.");
  }

  const recipientName = escapePromoHtml(ticket.buyerName);
  const eventName = escapePromoHtml(ticket.eventName);
  const ticketType = escapePromoHtml(ticket.ticketType);
  const location = escapePromoHtml(eventData.venue.name || "To be announced");
  const reason = escapePromoHtml(ticket.promoReason || "Promotional giveaway");

  await emailApi.sendTransacEmail({
    sender: {
      name: "AirTicks",
      email: process.env.EMAIL_FROM,
    },

    to: [
      {
        email: ticket.email,
        name: ticket.buyerName,
      },
    ],

    subject: `Your free giveaway ticket for ${ticket.eventName}`,

    htmlContent: `
      <!DOCTYPE html>
      <html>
        <body style="font-family:Arial,sans-serif;color:#171717;line-height:1.6">
          <div style="max-width:600px;margin:auto;padding:24px">
            <h1 style="color:#f97316">AirTicks</h1>

            <h2>Congratulations, ${recipientName}!</h2>

            <p>
              You've received a complimentary ticket to
              <strong>${eventName}</strong>.
            </p>

            <div style="padding:18px;background:#f5f5f5;border-radius:12px">
              <p><strong>Attendee:</strong> ${recipientName}</p>
              <p><strong>Event:</strong> ${eventName}</p>
              <p><strong>Ticket type:</strong> ${ticketType}</p>
              <p><strong>Location:</strong> ${location}</p>
              <p><strong>Ticket ID:</strong> ${escapePromoHtml(ticketId)}</p>
              <p><strong>Reason:</strong> ${reason}</p>
              <p><strong>Amount paid:</strong> ₦0</p>
            </div>

            <h3>Your QR ticket</h3>
            <p>
              Your QR code is attached to this email as a PNG image.
              Keep it safe and present it at the event entrance.
            </p>

            <p>
              This is an official complimentary ticket issued by AirTicks.
              No payment is required.
            </p>

            <p>Enjoy the event!<br />The AirTicks Team</p>
          </div>
        </body>
      </html>
    `,

    attachment: [
      {
        name: `AirTicks-Giveaway-${ticketId}.png`,
        content: ticket.qr,
      },
    ],
  });
};

/* =========================================
   ISSUE A PROMOTIONAL TICKET
   POST /api/admin/promo-tickets
========================================= */

app.post(
  "/api/admin/promo-tickets",
  authenticate,
  async (req, res) => {
    if (req.user.isAdmin !== true) {
      return res.status(403).json({
        error: "Only AirTicks administrators can issue giveaway tickets.",
      });
    }

    let ticketRef;

    try {
      const {
        eventId,
        attendeeName,
        attendeeEmail,
        promoReason = "Promotional giveaway",
      } = req.body;

      if (
        typeof eventId !== "string" ||
        !eventId.trim() ||
        typeof attendeeName !== "string" ||
        !attendeeName.trim() ||
        typeof attendeeEmail !== "string" ||
        !attendeeEmail.trim()
      ) {
        return res.status(400).json({
          error: "Event, attendee name, and attendee email are required.",
        });
      }

      const name = attendeeName.trim();
      const email = attendeeEmail.trim().toLowerCase();

      if (name.length > 120 || email.length > 254) {
        return res.status(400).json({
          error: "The attendee name or email is too long.",
        });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({
          error: "Enter a valid attendee email address.",
        });
      }

      if (
        typeof promoReason !== "string" ||
        promoReason.trim().length > 200
      ) {
        return res.status(400).json({
          error: "The giveaway reason must be 200 characters or fewer.",
        });
      }

      // Events are fetched by the backend, not trusted from the browser.
      const eventRef = db.collection("events").doc(eventId.trim());
      const eventSnap = await eventRef.get();

      if (!eventSnap.exists) {
        return res.status(404).json({
          error: "The selected event was not found.",
        });
      }

      const eventData = eventSnap.data();

      // Create a unique ticket document ID first.
      ticketRef = db.collection("tickets").doc();
      const ticketId = ticketRef.id;

      // The scanner receives the ticket document ID in the QR code.
      const qrDataUrl = await QRCode.toDataURL(ticketId, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: "M",
      });

      const qrBase64 = qrDataUrl.replace(
        /^data:image\/png;base64,/,
        ""
      );

      const ticket = {
        reference: `PROMO-${ticketId}`,
        eventId: eventRef.id,
        eventName: eventData.name || eventData.title || "Event",
        organizerId: eventData.ownerId || null,

        userId: null,
        email,
        buyerName: name,

        ticketNumber: 1,
        ticketType: "PROMO / GIVEAWAY",
        location: eventData.location || "TBA",

        amount: 0,
        status: "success",
        used: false,

        qr: qrBase64,

        ticketSource: "admin_promo",
        promoReason: promoReason.trim() || "Promotional giveaway",
        issuedBy: req.user.uid,
        issuedByEmail: req.user.email || null,

        emailStatus: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Save the actual ticket before sending the email.
      // No payment, wallet or revenue transaction occurs here.
      await ticketRef.set(ticket);

      await eventRef.update({
        attendeeCount: admin.firestore.FieldValue.increment(1),
        ticketSold: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      try {
        await sendPromoTicketEmail(ticketId, ticket, eventData);

        await ticketRef.update({
          emailStatus: "sent",
          emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(201).json({
          success: true,
          ticketId,
          emailSent: true,
          message: "Giveaway ticket created and emailed successfully.",
        });
      } catch (emailError) {
        console.error("Giveaway ticket email failed:", emailError);

        // Keep the created ticket. Do not issue a duplicate if
        // the email fails; allow the admin to resend it instead.
        await ticketRef.update({
          emailStatus: "failed",
          emailErrorAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(502).json({
          success: false,
          ticketCreated: true,
          ticketId,
          emailSent: false,
          error: "Ticket created, but the email failed. Use Resend Email.",
        });
      }
    } catch (error) {
      console.error("Promo ticket creation failed:", error);

      return res.status(500).json({
        error: "Could not issue the giveaway ticket.",
      });
    }
  }
);

/* =========================================
   RESEND A GIVEAWAY TICKET EMAIL
   POST /api/admin/promo-tickets/:ticketId/resend
========================================= */

app.post(
  "/api/admin/promo-tickets/:ticketId/resend",
  authenticate,
  async (req, res) => {
    if (req.user.isAdmin !== true) {
      return res.status(403).json({
        error: "Only AirTicks administrators can resend ticket emails.",
      });
    }

    try {
      const { ticketId } = req.params;

      const ticketRef = db.collection("tickets").doc(ticketId);
      const ticketSnap = await ticketRef.get();

      if (!ticketSnap.exists) {
        return res.status(404).json({
          error: "Ticket not found.",
        });
      }

      const ticket = ticketSnap.data();

      if (ticket.ticketSource !== "admin_promo") {
        return res.status(400).json({
          error: "This is not an admin promotional ticket.",
        });
      }

      const eventSnap = await db
        .collection("events")
        .doc(ticket.eventId)
        .get();

      if (!eventSnap.exists) {
        return res.status(404).json({
          error: "The event associated with this ticket no longer exists.",
        });
      }

      await sendPromoTicketEmail(
        ticketId,
        ticket,
        eventSnap.data()
      );

      await ticketRef.update({
        emailStatus: "sent",
        emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({
        success: true,
        ticketId,
        emailSent: true,
        message: "Giveaway ticket email resent successfully.",
      });
    } catch (error) {
      console.error("Promo ticket resend failed:", error);

      return res.status(500).json({
        error: "Could not resend the ticket email.",
      });
    }
  }
);


app.post(
  "/api/organization/promo-tickets",
  authenticate,
  async (req, res) => {
    try {
      const {
        eventId,
        attendeeName,
        attendeeEmail,
        promoReason = "Promotional giveaway",
      } = req.body;

      if (
        typeof eventId !== "string" ||
        !eventId.trim() ||
        typeof attendeeName !== "string" ||
        !attendeeName.trim() ||
        typeof attendeeEmail !== "string" ||
        !attendeeEmail.trim()
      ) {
        return res.status(400).json({
          error: "Event, attendee name, and attendee email are required.",
        });
      }

      const eventRef = db.collection("events").doc(eventId.trim());
      const eventSnap = await eventRef.get();

      if (!eventSnap.exists) {
        return res.status(404).json({
          error: "The selected event was not found.",
        });
      }

      const eventData = eventSnap.data();
      const isOwner = eventData.ownerId === req.user.uid;
      const isAdmin = req.user.isAdmin === true;

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "You can only gift tickets for your own events.",
        });
      }

      const name = attendeeName.trim();
      const email = attendeeEmail.trim().toLowerCase();

      if (name.length > 120 || email.length > 254) {
        return res.status(400).json({
          error: "The attendee name or email is too long.",
        });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({
          error: "Enter a valid attendee email address.",
        });
      }

      if (typeof promoReason !== "string" || promoReason.trim().length > 200) {
        return res.status(400).json({
          error: "The giveaway reason must be 200 characters or fewer.",
        });
      }

      const ticketRef = db.collection("tickets").doc();
      const ticketId = ticketRef.id;
      const qrDataUrl = await QRCode.toDataURL(ticketId, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: "M",
      });
      const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");

      const ticket = {
        reference: `PROMO-${ticketId}`,
        eventId: eventRef.id,
        eventName: eventData.name || eventData.title || "Event",
        organizerId: eventData.ownerId || null,
        userId: null,
        email,
        buyerName: name,
        ticketNumber: 1,
        ticketType: "PROMO / GIVEAWAY",
        location: eventData.location || "TBA",
        amount: 0,
        status: "success",
        used: false,
        qr: qrBase64,
        ticketSource: "organizer_promo",
        promoReason: promoReason.trim() || "Promotional giveaway",
        issuedBy: req.user.uid,
        issuedByEmail: req.user.email || null,
        emailStatus: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await ticketRef.set(ticket);

      await eventRef.update({
        attendeeCount: admin.firestore.FieldValue.increment(1),
        ticketSold: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      try {
        await sendPromoTicketEmail(ticketId, ticket, eventData);
        await ticketRef.update({
          emailStatus: "sent",
          emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(201).json({
          success: true,
          ticketId,
          emailSent: true,
          message: "Giveaway ticket created and emailed successfully.",
        });
      } catch (emailError) {
        console.error("Organizer promo ticket email failed:", emailError);

        await ticketRef.update({
          emailStatus: "failed",
          emailErrorAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.status(502).json({
          success: false,
          ticketCreated: true,
          ticketId,
          emailSent: false,
          error: "Ticket created, but the email failed. Use resend email if available.",
        });
      }
    } catch (error) {
      console.error("Organizer promo ticket creation failed:", error);
      return res.status(500).json({
        error: "Could not issue the giveaway ticket.",
      });
    }
  }
);

app.post(
  "/api/organization/promo-tickets/:ticketId/resend",
  authenticate,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const ticketRef = db.collection("tickets").doc(ticketId);
      const ticketSnap = await ticketRef.get();

      if (!ticketSnap.exists) {
        return res.status(404).json({ error: "Ticket not found." });
      }

      const ticket = ticketSnap.data();

      if (ticket.ticketSource !== "organizer_promo") {
        return res.status(400).json({
          error: "This is not an organizer promotional ticket.",
        });
      }

      const eventSnap = await db.collection("events").doc(ticket.eventId).get();

      if (!eventSnap.exists) {
        return res.status(404).json({
          error: "The event associated with this ticket no longer exists.",
        });
      }

      const eventData = eventSnap.data();
      const isOwner = eventData.ownerId === req.user.uid;
      const isAdmin = req.user.isAdmin === true;

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "You can only resend emails for your own event tickets.",
        });
      }

      await sendPromoTicketEmail(ticketId, ticket, eventData);
      await ticketRef.update({
        emailStatus: "sent",
        emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({
        success: true,
        ticketId,
        emailSent: true,
        message: "Giveaway ticket email resent successfully.",
      });
    } catch (error) {
      console.error("Organizer promo ticket resend failed:", error);
      return res.status(500).json({
        error: "Could not resend the ticket email.",
      });
    }
  }
    );

app.post('/api/tickets/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized'
      })
    }

    const token = authHeader.split(' ')[1]

    const decoded = await admin.auth().verifyIdToken(token)

    const scannerDoc = await db.collection('users').doc(decoded.uid).get()

    if (!scannerDoc.exists) {
      return res.status(404).json({
        error: 'User not found'
      })
    }

    const scanner = scannerDoc.data()

    if (!scanner.isAdmin && scanner.accountType !== 'organization') {
      return res.status(403).json({
        error: 'Only organizers and admins can verify tickets.'
      })
    }

    const { ticketId } = req.body

    const ticketRef = db.collection('tickets').doc(ticketId)

    const ticketDoc = await ticketRef.get()

    if (!ticketDoc.exists) {
      return res.status(404).json({
        error: 'Ticket not found.'
      })
    }

    const ticket = ticketDoc.data()

    if (ticket.used) {
      return res.status(409).json({
        error: 'Ticket already used.',
        buyerName: ticket.buyerName,
        eventName: ticket.eventName
      })
    }

    await ticketRef.update({
      used: true,
      scannedAt: admin.firestore.FieldValue.serverTimestamp(),
      scannedBy: decoded.uid,
      scannedByName:
        scanner.fullName || scanner.displayName || scanner.name || 'Admin'
    })

    res.json({
      success: true,
      attendeeName: ticket.attendeeName,
      purchaserName: ticket.purchaserName,
      eventName: ticket.eventName,
      ticketType: ticket.ticketType,
      ticketNumber: ticket.ticketNumber,
      used: ticket.used,
      scannedByName: ticket.scannedByName || null
    })
  } catch (err) {
    console.error(err)

    res.status(500).json({
      error: 'Verification failed.'
    })
  }
})

app.get('/api/tickets/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params

    const ticketDoc = await db.collection('tickets').doc(ticketId).get()

    if (!ticketDoc.exists) {
      return res.status(404).json({
        error: 'Ticket not found.'
      })
    }

    const ticket = ticketDoc.data()

    res.json({
      attendeeName: ticket.attendeeName,
      purchaserName: ticket.purchaserName,
      eventName: ticket.eventName,
      ticketType: ticket.ticketType,
      ticketNumber: ticket.ticketNumber,
      used: ticket.used,
      scannedByName: ticket.scannedByName || null,
      scannedAt: ticket.scannedAt ? ticket.scannedAt.toDate() : null
    })
  } catch (err) {
    console.error(err)

    res.status(500).json({
      error: 'Server error.'
    })
  }
})

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
