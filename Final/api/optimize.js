import { GoogleGenerativeAI } from '@google/generative-ai';
import formidable from 'formidable';
import { promises as fs } from 'fs';
import path from 'path';

// --- Configuration ---
const MODEL_OPTIONS = [
  'gemini-2.5-flash-lite',   // Primary - fast & reliable on free tier
  'gemini-2.5-flash',
  'gemini-flash-latest'
];

const GENERATION_CONFIG = {
  temperature: 1.0,
  topP: 0.95,
  maxOutputTokens: 4096,
};

// --- Midjourney System Prompt ---
const getSystemPrompt = () => `
You are an expert Midjourney prompt engineer.

Your job is to take a user's simple idea (and optional reference image) and turn it into a high-quality, detailed Midjourney prompt.

Rules:
- Output in clear, readable sections with headings.
- Be highly descriptive and cinematic/artistic.
- Include subject details, lighting, mood, composition, camera angle, and artistic style.
- Suggest good Midjourney parameters at the end (--ar, --v, --stylize, --q, etc.).
- If an image is provided, analyze it and incorporate relevant visual elements, style, or composition from it.

Format your response like this:

**Optimized Midjourney Prompt**
[Full ready-to-copy Midjourney prompt here]

**Breakdown**
**Foreground:** ...
**Midground:** ...
**Background:** ...
**Style & Mood:** ...
**Lighting & Atmosphere:** ...

**Recommended Parameters**
--ar ... --v 6 --stylize ... etc.
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const form = formidable({ multiples: false });
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve([fields, files]);
      });
    });

    const userPrompt = fields.userPrompt?.[0] || '';
    const imageUrl = fields.imageUrl?.[0] || '';

    if (!userPrompt.trim() && !imageUrl && !files.image?.[0]) {
      return res.status(400).json({ error: 'Please provide a prompt or an image.' });
    }

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    const parts = [
      { text: getSystemPrompt() },
      { text: `User's idea: ${userPrompt}` },
    ];

    // Handle uploaded image file
    if (files.image?.[0]) {
      const file = files.image[0];
      const buffer = await fs.readFile(file.filepath);
      parts.push({
        inlineData: {
          mimeType: file.mimetype || 'image/jpeg',
          data: buffer.toString('base64'),
        },
      });
      await fs.unlink(file.filepath).catch(() => {});
    }

    // Handle image URL (if frontend sends one)
    if (imageUrl) {
      parts.push({ text: `Reference image URL: ${imageUrl}` });
    }

    // Model fallback
    let result;
    let lastError;

    for (const modelName of MODEL_OPTIONS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        result = await model.generateContent({
          contents: [{ role: 'user', parts }],
          generationConfig: GENERATION_CONFIG,
        });
        console.log(`✅ Used model: ${modelName}`);
        break;
      } catch (err) {
        lastError = err;
        console.warn(`Model ${modelName} failed:`, err.message);
        if (err.message?.toLowerCase().includes('quota') || err.status === 429) {
          throw err;
        }
      }
    }

    if (!result) throw lastError || new Error('All models failed');

    const responseText = result.response.text();

    res.status(200).json({ optimizedText: responseText });

  } catch (error) {
    console.error('API Error:', error);

    let message = error.message || 'Something went wrong';
    if (message.toLowerCase().includes('quota') || error.status === 429) {
      message = "Free tier is busy — please wait 30-60 seconds and try again.";
    }

    res.status(500).json({ error: message });
  }
}
