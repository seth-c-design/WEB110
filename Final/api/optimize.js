import { GoogleGenerativeAI } from '@google/generative-ai';
import formidable from 'formidable';
import { promises as fs } from 'fs';
import path from 'path';

// --- Configuration ---
const PROMPT_TEMPLATE_PATH = 'assets/Prompt_template.json';
const MODEL_OPTIONS = [
  'gemini-2.5-flash-lite',      // Primary: fastest/cheapest free-tier friendly
  'gemini-2.5-flash',           // Solid backup
  'gemini-flash-latest'         // Alias for newest stable Flash
];

const GENERATION_CONFIG = {
  temperature: 1.1,
  topP: 0.95,
  maxOutputTokens: 8192,
  responseMimeType: "application/json",
  responseJsonSchema: {
    // Paste the entire schema object from above here if you want even stricter enforcement
    // (or keep it simple and rely on the system prompt + template)
  }
};

const getSystemPrompt = (template) => `
You are a specialized AI assistant for generating video prompts for Google's VEO model.

CRITICAL INSTRUCTIONS:
- You MUST output ONLY valid JSON that exactly matches the provided JSON Schema.
- Do not add any text, explanations, markdown, or comments outside the JSON.
- Follow every property, type, and constraint in the schema.
- Keep total duration ≤ 8 seconds.
- Be extremely detailed and cinematic in all descriptions.

Here is the exact JSON Schema you must follow:
${template}

Now generate the filled JSON for the user's idea.
`;

const getFilepathToPromptTemplate = () => {
  const isVercel = process.env.VERCEL;
  return isVercel 
    ? path.join(process.cwd(), PROMPT_TEMPLATE_PATH) 
    : PROMPT_TEMPLATE_PATH;
};

// Helper for model fallback
async function tryGenerate(genAI, userPrompt, template, imageData = null) {
  for (const modelName of MODEL_OPTIONS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const parts = [
        { text: getSystemPrompt(template) },
        { text: template },
        { text: userPrompt },
      ];

      if (imageData) {
        parts.push(imageData);
      }

      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: GENERATION_CONFIG,
      });

      console.log(`✅ Success with model: ${modelName}`);
      return result.response.text();
    } catch (e) {
      console.warn(`⚠️ Model ${modelName} failed:`, e.message);
      if (e.message?.includes('quota') || e.status === 429) {
        throw e; // Surface quota errors immediately for frontend handling
      }
      // Continue to next model on other errors
    }
  }
  throw new Error('All models failed. Free tier may be busy.');
}

// --- Main Handler ---
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Read template
    const templatePath = getFilepathToPromptTemplate();
    const template = await fs.readFile(templatePath, 'utf-8');

    // 2. Parse form
    const form = formidable({ multiples: false });
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve([fields, files]);
      });
    });

    const userPrompt = fields.userPrompt?.[0] || '';
    if (!userPrompt.trim()) {
      return res.status(400).json({ error: 'Prompt cannot be empty.' });
    }

    // 3. Prepare Gemini
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    let imageData = null;
    if (files.image?.[0]) {
      const file = files.image[0];
      const buffer = await fs.readFile(file.filepath);
      imageData = {
        inlineData: {
          mimeType: file.mimetype || 'image/jpeg',
          data: buffer.toString('base64'),
        },
      };
      await fs.unlink(file.filepath).catch(() => {}); // Cleanup
    }

    // 4. Generate with fallback
    const responseText = await tryGenerate(genAI, userPrompt, template, imageData);

    // 5. Validate & respond
    try {
      const jsonResponse = JSON.parse(responseText);
      res.status(200).json({ 
        optimizedText: JSON.stringify(jsonResponse, null, 2),
        modelUsed: 'success' // Optional: you can track which model succeeded if desired
      });
    } catch (e) {
      console.error("JSON parse failed:", responseText);
      res.status(500).json({ error: "AI returned invalid JSON. Please try again." });
    }

  } catch (error) {
    console.error('API Error:', error);

    let userMessage = `An internal server error occurred: ${error.message}`;
    
    if (error.message?.toLowerCase().includes('quota') || error.status === 429) {
      userMessage = "Free tier is busy right now — please wait 30-60 seconds and try again.";
    } else if (error.message?.includes('API key') || error.status === 401) {
      userMessage = "API key issue. Check your Vercel environment variable.";
    }

    res.status(500).json({ error: userMessage });
  }
}
