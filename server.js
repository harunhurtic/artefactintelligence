import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import mongoose from "mongoose"
import favicon from "serve-favicon";
import path from "path";
import { fileURLToPath } from "url"; // Needed for ES Modules
/*import fs from "fs";*/  // Only enable if 'export' endpoints are enabled

dotenv.config();

const app = express();
app.use(express.json());

/* Un-comment out this part if you want to run the app locally*/
/* app.use(cors());*/

/*Comment out this whole "app.use" part out if you want to run the app locally (and replace all urls in front of /fetch in Index.html), and then un-comment the "app.use(cors());" above it. */
app.use(cors({
    origin: "https://artefactintelligence.hurtic.net",  // 🔄 Replace url with your frontend URL
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

const OPENAI_HEADERS = {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2"  // Required for Assistants API v2
};

// Connect to MongoDB
mongoose.set("strictQuery", true);
mongoose.set("bufferCommands", false); // Prevents buffering if disconnected

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 30000, // ⏳ Increase timeout to 30 seconds
    socketTimeoutMS: 45000, // Increase query timeout
})
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => {
        console.error("❌ MongoDB Connection Error:", err);
        process.exit(1); // 🚨 Exit if database is unavailable
    });

// Debugging: Listen for connection events
mongoose.connection.on("connecting", () => console.log("⏳ Connecting to MongoDB..."));
mongoose.connection.on("connected", () => console.log("✅ MongoDB connected successfully!"));
mongoose.connection.on("error", err => console.error("❌ MongoDB Error:", err));
mongoose.connection.on("disconnected", () => console.error("⚠️ MongoDB Disconnected!"));

const threadSchema = new mongoose.Schema({
    threadId: String,
    participantId: String,
    artefact: String,
    createdAt: { type: Date, default: Date.now },
    messages: [{ role: String, content: String, timestamp: Date }]
});

const Thread = mongoose.model("Thread", threadSchema);

// Get correct directory paths for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the frontend files
app.use(express.static(path.join(__dirname, "public")));  // Serves static files from "public" folder

app.use(favicon(path.join(__dirname, "public", "favicon.ico")));

// Route to serve the main HTML file
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "Index.html"));
});

// API route for fetching adapted descriptions with failure detection
app.post("/fetch-description", async (req, res) => {
    console.log("🛠️ Received fetch-description request:", req.body);

    const { artefact, originalDescription, profile, threadId, language, tone } = req.body;

    if (!artefact || !originalDescription || !profile) {
        console.error("❌ Missing required fields");
        return res.status(400).json({ error: "Missing artefact or profile" });
    }

    // Ensure the request is for the latest artefact
    if (req.body.artefact !== artefact) {
        console.log("🔄 Artefact changed, ignoring outdated request.");
        return res.status(400).json({ response: "Artefact changed, ignoring outdated request." });
    }

    try {
        let thread;

        if (threadId) {
            thread = await Thread.findOne({ threadId });

            if (thread && thread.artefact !== artefact) {
                console.log(`🔄 Thread ID belongs to a different artefact (${thread.artefact} vs ${artefact}). Resetting thread.`);
                thread = null;
            }

            if (thread) {
                console.log(`🔄 Using existing Thread ID: ${threadId}`);
            }
        }

        if (!thread) {
            console.log("🟢 Creating a new thread...");
            const threadResponse = await fetch("https://api.openai.com/v1/threads", {
                method: "POST",
                headers: OPENAI_HEADERS,
                timeout: 60000,
            });

            const threadData = await threadResponse.json();

            if (!threadData.id) {
                console.error("❌ Failed to create thread.");
                return res.status(500).json({ response: "Error: Could not create assistant thread." });
            }

            thread = new Thread({
                threadId: threadData.id,
                profile,
                artefact,
                createdAt: new Date(),
                messages: []
            });

            await thread.save();
            console.log(`✅ Created Thread ID: ${thread.threadId}`);
        }

        let prompt = `Adapt the following artefact description in ${language} and make it more engaging for a museum visitor with the "${profile}" profile, while preserving the conciseness and factual accuracy. Ensure that the adaptation aligns with the preferences, interests, and motivations of their profile, without explicitly mentioning their profile or adding unnecessary details.\n\nArtefact: "${artefact}".\nDescription: "${originalDescription}"`;

        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/messages`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ role: "user", content: prompt }),
            timeout: 60000,
        });

        const messageData = await messageResponse.json();

        if (!messageData.id) {
            console.error("❌ Failed to add message.");
            return res.status(500).json({ response: "Error: Could not send prompt to assistant." });
        }

        thread.messages.push({
            role: "user",
            content: prompt,
            timestamp: new Date()
        });

        await thread.save();

        const runResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/runs`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
            timeout: 60000,
        });

        const runData = await runResponse.json();

        if (!runData.id) {
            console.error("❌ Failed to start assistant.");
            return res.status(500).json({ response: "Error: Assistant could not start processing." });
        }

        let status = "in_progress";
        let responseContent = "";
        let attemptCount = 0;

        while (status === "in_progress" || status === "queued") {
            if (attemptCount > 10) {
                console.error("⏳ Assistant took too long. Timing out.");
                return res.status(500).json({ response: "Error: Assistant took too long to respond." });
            }

            await new Promise(resolve => setTimeout(resolve, 3000));
            attemptCount++;

            const checkRunResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/runs/${runData.id}`, {
                headers: OPENAI_HEADERS,
            });

            const checkRunData = await checkRunResponse.json();
            status = checkRunData.status;

            if (status === "completed") {
                const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/messages`, {
                    headers: OPENAI_HEADERS,
                });

                const messagesData = await messagesResponse.json();
                const assistantMessage = messagesData.data.find(msg => msg.role === "assistant");

                responseContent = assistantMessage?.content[0]?.text?.value || "Adaptation failed.";

                thread.messages.push({
                    role: "assistant",
                    content: responseContent,
                    timestamp: new Date()
                });

                await thread.save();
                break;
            }
        }

        res.json({ response: responseContent, threadId: thread.threadId });

    } catch (error) {
        console.error("❌ Error with Assistant:", error);
        res.status(500).json({ response: `Adaptation failed. However, here's the original description:\n\n${originalDescription}` });
    }
});

// API route for fetching additional artefact details (for "Tell Me More" button)
app.post("/fetch-more-info", async (req, res) => {
    console.log("🛠️ Received fetch-more-info request:", req.body);

    const { artefact, profile, threadId, currentDescription, language } = req.body;

    if (!artefact || !profile || !threadId) {
        console.error("❌ Missing required fields: artefact, profile, or threadId");
        return res.status(400).json({ error: "Missing artefact, profile, or threadId" });
    }

    try {
        const thread = await Thread.findOne({ threadId });
        if (!thread) {
            console.error("❌ No existing thread found.");
            return res.status(400).json({ error: "No existing thread found." });
        }

        if (req.body.artefact !== artefact) {
            console.log("🔄 Artefact changed, ignoring outdated 'Tell Me More' request.");
            return res.status(400).json({ response: "Artefact changed, ignoring outdated request." });
        }

        let prompt = `The visitor with the "${profile}" profile wants to learn more about the "${artefact}" artefact. They have already seen the following information: "${currentDescription}". \n Provide additional, non-redundant information in ${language} that expands on the artefact. The new content should remain engaging, accurate, and adapted to the visitor’s assigned profile preferences without explicitly referencing their profile or repeating previous details. If no new information is available to provide, just offer an acknowledgment of that while maintaining an informative tone.`;

        thread.messages.push({
            role: "user",
            content: prompt,
            timestamp: new Date()
        });
        await thread.save();

        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ role: "user", content: prompt }),
            timeout: 60000,
        });
        const messageData = await messageResponse.json();

        if (!messageData.id) {
            console.error("❌ Failed to add message (Tell Me More).");
            return res.status(500).json({ response: "Error: Could not send 'Tell Me More' prompt to assistant." });
        }

        const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
            timeout: 60000,
        });
        const runData = await runResponse.json();
        if (!runData.id) {
            console.error("❌ Failed to start assistant.");
            return res.status(500).json({ response: "Error: Assistant could not start processing." });
        }

        // 5) POLL for completion
        let status = "in_progress";
        let responseContent = "";
        let attemptCount = 0;
        while (status === "in_progress" || status === "queued") {
            if (attemptCount > 10) {
                console.error("⏳ Assistant took too long. Timing out.");
                return res.status(500).json({ response: "Error: Assistant took too long to respond." });
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
            attemptCount++;

            const checkRunResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runData.id}`, {
                headers: OPENAI_HEADERS,
            });
            const checkRunData = await checkRunResponse.json();
            status = checkRunData.status;

            if (status === "completed") {
                const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
                    headers: OPENAI_HEADERS,
                });
                const messagesData = await messagesResponse.json();
                const assistantMessage = messagesData.data.find(msg => msg.role === "assistant");

                responseContent = assistantMessage?.content[0]?.text?.value || "No additional information found.";
                thread.messages.push({
                    role: "assistant",
                    content: responseContent,
                    timestamp: new Date()
                });
                await thread.save();
                break;
            }
        }

        res.json({ response: responseContent });

    } catch (error) {
        console.error("❌ Error fetching additional info:", error);
        res.status(500).json({ response: "Failed to fetch additional information." });
    }
});

app.post("/fetch-tts", async (req, res) => {
    const { text, voice } = req.body;

    if (!text) {
        return res.status(400).json({ error: "Missing text input for TTS" });
    }

    try {
        const audioBuffer = await fetchTTSWithRetry(text, voice);

        res.set({
            "Content-Type": "audio/mpeg",
            "Content-Length": audioBuffer.length,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        });

        res.send(audioBuffer);
    } catch (error) {
        console.error("❌ Error fetching TTS:", error);
        res.status(500).json({ error: "Failed to generate TTS audio" });
    }
});

// Function to fetch TTS with automatic retries
async function fetchTTSWithRetry(text, voice, retries = 3) {

    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Sending Text-to-Speech Request (Attempt ${i + 1}) with voice: ${voice}...`);

            const response = await fetch("https://api.openai.com/v1/audio/speech", {
                method: "POST",
                headers: OPENAI_HEADERS,
                body: JSON.stringify({
                    model: "tts-1",
                    input: text,
                    voice: voice,
                    speed: 1.0,
                }),
                timeout: 60000,  // ✅ Increase timeout to 60s
            });

            if (!response.ok) throw new Error(`Failed to generate audio: ${response.statusText}`);

            const audioBuffer = await response.arrayBuffer();
            console.log("🔊 TTS Audio successfully generated!");
            return Buffer.from(audioBuffer);
        } catch (error) {
            console.error(`❌ TTS attempt ${i + 1} failed:`, error);
            if (i === retries - 1) {
                console.error("🚨 TTS service unavailable after multiple retries.");
                throw error;
            }
            await new Promise(res => setTimeout(res, 2000)); // ⏳ Wait before retrying
        }
    }
}

/* When enabling these two endpoints, the first one will display the stored threads in a .json format from the Assistants API and 
the second endpoint will export them as a .json file.  

app.get("/fetch-stored-threads", async (req, res) => {
    try {
        const threads = await Thread.find({}); // Fetch all stored threads from MongoDB
        res.json({ threads });
    } catch (error) {
        console.error("❌ Error fetching stored threads:", error);
        res.status(500).json({ error: "Failed to fetch stored threads" });
    }
});

app.get("/export-threads", async (req, res) => {
    try {
        const threads = await Thread.find({});
        const jsonData = JSON.stringify(threads, null, 2);

        fs.writeFileSync("threads.json", jsonData);
        console.log("✅ Threads exported to threads.json");

        res.download("threads.json"); // Sends file as download
    } catch (error) {
        console.error("❌ Error exporting threads:", error);
        res.status(500).json({ error: "Failed to export threads" });
    }
});

*/
console.log("🔑 OpenAI API Key:", process.env.OPENAI_API_KEY ? "Loaded" : "MISSING");
console.log("🤖 Assistant ID:", process.env.ASSISTANT_ID ? "Loaded" : "MISSING");


// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

/* Proof-of-Concept Developed by Harun Hurtic as part of his Master's Thesis at the Norwegian University of Science and Technology (NTNU) */