import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import axios from "axios";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Initialize the Google Gen AI SDK
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Endpoint 1: Generate Improved Description
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
const PORT = process.env.AI_PORT || 5000;

app.listen(PORT, () => {
  console.log(`AI server running on port ${PORT}`);
});