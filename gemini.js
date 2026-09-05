const { GoogleGenerativeAI } = require("@google/generative-ai");

// You'll need to set your Gemini API key in process.env.GEMINI_API_KEY
// or hardcode it here for the hackathon (but be careful not to commit it publicly)
const API_KEY = process.env.GEMINI_API_KEY || "YOUR_API_KEY_HERE";

const genAI = new GoogleGenerativeAI(API_KEY);

// We use Flash for speed (perfect for hackathons)
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

/**
 * Summarize a single file's content
 */
async function summarizeFile(content, filename = "") {
    try {
        // Truncate to first 4000 characters to save tokens/time
        const snippet = content.slice(0, 4000);

        const prompt = `
    You are an AI assistant in a smart file manager called NexaFiles.
    Please provide a concise, 2-3 sentence summary of the following file content.
    File name: ${filename}
    
    Content:
    ${snippet}
    `;

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error("Gemini summarizeFile error:", error);
        return "Failed to generate summary. Please check your API key.";
    }
}

/**
 * Summarize an entire folder's contents based on file metadata
 */
async function summarizeFolder(filesList) {
    try {
        const fileStrs = filesList.slice(0, 50).map(f => `- ${f.name} (${f.size} bytes)`).join('\n');

        const prompt = `
    You are an AI assistant in NexaFiles. 
    Look at this list of files in a folder and write a 2-sentence summary of what this folder is for (e.g., "This looks like a React web project", or "This contains mostly financial spreadsheets from 2023").
    
    Files:
    ${fileStrs}
    `;

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error("Gemini summarizeFolder error:", error);
        return "Failed to summarize folder.";
    }
}

/**
 * Generate 3-5 smart tags for a file based on its content
 */
async function generateTags(content, filename = "") {
    try {
        const snippet = content.slice(0, 2000);
        const prompt = `
    Generate exactly 4 comma-separated tags for this file content. Do not output anything else. No quotes, no markdown.
    Filename: ${filename}
    Content: ${snippet}
    `;

        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/"/g, '').trim();
        return text.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    } catch (error) {
        console.error("Gemini generateTags error:", error);
        return [];
    }
}

/**
 * Full NLP chat response
 */
async function chatWithAI(message, contextData = {}) {
    try {
        // Inject context like selected files or current directory into the prompt
        let contextStr = "";
        if (contextData.selectedFiles && contextData.selectedFiles.length > 0) {
            const names = contextData.selectedFiles.map(f => f.name).join(', ');
            contextStr = `\nThe user currently has these files selected in the UI: ${names}`;
        }

        const prompt = `
    You are NexaFiles AI, an intelligent storage assistant. You help users find duplicates, compress files, organize their messy folders, and answer questions about their data.
    Be helpful, concise, and professional.
    ${contextStr}
    
    User message: ${message}
    `;

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error("Gemini chatWithAI error:", error);
        return "I'm having trouble connecting to my brain (Gemini API). Please check the API key configuration!";
    }
}

module.exports = {
    summarizeFile,
    summarizeFolder,
    generateTags,
    chatWithAI
};
