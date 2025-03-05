import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import mongoose from "mongoose"
import favicon from "serve-favicon";
import path from "path";
import { fileURLToPath } from "url"; // Needed for ES Modules
/*import fs from "fs";*/

dotenv.config();
const app = express();
app.use(express.json());

/* Un-comment out this part if you want to run the app locally */
/*app.use(cors());*/

/* Comment out this whole "app.use" part out if you want to run the app locally (and replace all urls in front of /fetch in Index.html), and then un-comment the "app.use(cors());" above it. */
app.use(cors({
    origin: "https://artefactintelligencestudy.hurtic.net",  // Replace url with your frontend URL
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
    createdAt: { type: Date, default: Date.now },
    messages: [{ role: String, content: String, timestamp: Date }],
    artefactInteractions: [{
        artefact: String,
        descriptionType: String,
        profile: String,
        timeSpentSeconds: { type: Number, default: 0 },
        tellMeMoreClicked: { type: Number, default: 0 },
        deliveryMode: { type: String, enum: ["Text-Based", "Auditory"], required: true },
        playedAudio: { type: String, enum: ["Yes", "No"], default: "No" },
        timestamp: { type: Date, default: Date.now }
    }]
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

app.post("/log-artefact-data", async (req, res) => {
    const { participantId, artefact, descriptionType, profile, deliveryMode, playedAudio } = req.body;

    // Ensure numbers are valid or default to 0
    let timeSpentSeconds = Number(req.body.timeSpentSeconds);
    if (isNaN(timeSpentSeconds)) timeSpentSeconds = 0;

    let tellMeMoreClicked = Number(req.body.tellMeMoreClicked);
    if (isNaN(tellMeMoreClicked)) tellMeMoreClicked = 0;

    console.log("🔍 Logging Artefact Data:", {
        participantId,
        artefact,
        descriptionType,
        profile,
        timeSpentSeconds,
        tellMeMoreClicked,
        deliveryMode,
        playedAudio
    });

    if (!participantId || !artefact || !descriptionType || !profile) {
        return res.status(400).json({ error: "Missing required artefact data fields." });
    }

    try {
        let thread = await Thread.findOne({ participantId });

        if (!thread) {
            thread = new Thread({
                participantId,
                createdAt: new Date(),
                messages: [],
                artefactInteractions: []
            });
        }

        const existingInteractionIndex = thread.artefactInteractions.findIndex(
            interaction => interaction.artefact === artefact
        );

        if (existingInteractionIndex !== -1) {
            // Safely update existing interaction
            thread.artefactInteractions[existingInteractionIndex].timeSpentSeconds += timeSpentSeconds;
            thread.artefactInteractions[existingInteractionIndex].tellMeMoreClicked += tellMeMoreClicked;
            thread.artefactInteractions[existingInteractionIndex].deliveryMode = deliveryMode;
            thread.artefactInteractions[existingInteractionIndex].playedAudio = playedAudio;
            thread.artefactInteractions[existingInteractionIndex].timestamp = new Date();
        } else {
            // Add new artefact interaction with sanitized data
            thread.artefactInteractions.push({
                artefact,
                descriptionType,
                profile,
                timeSpentSeconds,
                tellMeMoreClicked,
                deliveryMode,
                playedAudio,
                timestamp: new Date()
            });
        }

        await thread.save();
        console.log("✅ Artefact data logged/updated in thread:", thread);
        res.status(200).json({ message: "Artefact data logged/updated successfully." });

    } catch (error) {
        res.status(500).json({ error: "Failed to log artefact data." });
    }
});

// API route for fetching adapted descriptions with failure detection
app.post("/fetch-description", async (req, res) => {
    console.log("🛠️ Received fetch-description request:", req.body);

    const { artefact, originalDescription, profile, participantId } = req.body;

    if (!artefact || !originalDescription || !profile || !participantId) {
        console.error("❌ Missing required fields");
        return res.status(400).json({ error: "Missing artefact, profile, or participantId" });
    }

    let prompt = `Adapt the following artefact description and make it more engaging for a museum visitor with the "${profile}" profile while preserving factual accuracy. Ensure that the adaptation aligns with the preferences, interests, and motivations of their profile, without explicitly mentioning their profile or adding unnecessary details.\n\nArtefact: "${artefact}".\nDescription: "${originalDescription}"`;

    try {
        let thread = await Thread.findOne({ participantId });

        if (!thread || !thread.threadId) { //Ensure threadId exists
            console.log("🟢 Creating a new thread...");
            const threadResponse = await fetch("https://api.openai.com/v1/threads", {
                method: "POST",
                headers: OPENAI_HEADERS,
                body: JSON.stringify({ metadata: { participantId } }),
                timeout: 60000,
            });

            const threadData = await threadResponse.json();
            console.log("🔍 Thread Data:", JSON.stringify(threadData, null, 2));

            if (!threadData.id) {
                console.error("❌ Failed to create thread.");
                return res.status(500).json({ response: "Error: Could not create assistant thread." });
            }

            thread = new Thread({
                threadId: threadData.id,
                participantId,
                profile,
                createdAt: new Date(),
                artefact,
                originalDescription,
                messages: []
            });

            await thread.save();
            console.log(`✅ Created Thread ID: ${thread.threadId} for Participant: ${participantId}`);
        } else {
            console.log(`🔄 Using existing Thread ID: ${thread.threadId}`);
        }

        console.log("📝 Sending prompt to Assistant...");
        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/messages`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ role: "user", content: prompt }),
            timeout: 60000,
        });

        const messageData = await messageResponse.json();
        console.log("🔍 Message Data:", JSON.stringify(messageData, null, 2));

        if (!messageData.id) {
            console.error("❌ Failed to add message.");
            return res.status(500).json({ response: "Error: Could not send prompt to assistant." });
        }

        // Store the prompt in the database
        thread.messages.push({
            role: "user",
            content: prompt,
            timestamp: new Date()
        });

        await thread.save();

        console.log("▶️ Running Assistant...");
        const runResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/runs`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
            timeout: 60000,
        });

        const runData = await runResponse.json();
        console.log("🔍 Run Data:", JSON.stringify(runData, null, 2));

        if (!runData.id) {
            console.error("❌ Failed to start assistant.");
            return res.status(500).json({ response: "Error: Assistant could not start processing." });
        }

        const runId = runData.id;
        console.log(`✅ Run started. Run ID: ${runId}`);

        let status = "in_progress";
        let responseContent = "";
        let attemptCount = 0;

        while (status === "in_progress" || status === "queued") {
            if (attemptCount > 10) {
                console.error("⏳ Assistant took too long. Timing out.");
                return res.status(500).json({ response: "Error: Assistant took too long to respond." });
            }

            await new Promise(resolve => setTimeout(resolve, 3000));  // Wait 3s before checking again
            attemptCount++;

            const checkRunResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/runs/${runId}`, {
                headers: OPENAI_HEADERS,
            });

            const checkRunData = await checkRunResponse.json();
            console.log("⏳ Assistant Status:", checkRunData.status);

            status = checkRunData.status;

            if (status === "failed") {
                console.error("❌ Assistant Run Failed:", checkRunData);
            }

            if (status === "completed") {
                console.log("📩 Fetching Assistant's Response...");
                const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${thread.threadId}/messages`, {
                    headers: OPENAI_HEADERS,
                });

                const messagesData = await messagesResponse.json();
                console.log("📥 Messages Data:", JSON.stringify(messagesData, null, 2));

                const assistantMessage = messagesData.data.find(msg => msg.role === "assistant");

                if (!assistantMessage || !assistantMessage.content || !assistantMessage.content[0]) {
                    console.error("⚠️ No valid response from Assistant.");
                    return res.status(500).json({ response: `Adaptation failed. However, here's the original description:\n\n${originalDescription}` });
                }

                responseContent = assistantMessage.content[0].text.value;

                // Save assistant's response into the thread
                thread.messages.push({
                    role: "assistant",
                    content: responseContent,
                    timestamp: new Date()
                });

                await thread.save();
                console.log("✅ Assistant response saved to thread.");
                break;
            }
        }

        if (!responseContent) {
            responseContent = `Adaptation failed. However, here's the original description:\n\n${originalDescription}`;
        }

        res.json({ response: responseContent });

    } catch (error) {
        console.error("❌ Error with Assistant:", error);
        res.status(500).json({ response: `Adaptation failed. However, here's the original description:\n\n${originalDescription}` });
    }
});

// API route for fetching additional artefact details (for "Tell Me More" button)
app.post("/fetch-more-info", async (req, res) => {
    console.log("🛠️ Received fetch-more-info request:", req.body);

    const { artefact, profile, participantId, currentDescription } = req.body;

    if (!artefact || !profile || !participantId || !currentDescription) {
        console.error("❌ Missing required fields: artefact, profile, participantId, or currentDescription");
        return res.status(400).json({ error: "Missing artefact, profile, participantId, or currentDescription" });
    }

    try {
        let thread = await Thread.findOne({ participantId });

        // If no thread exists, create a new one
        if (!thread || !thread.threadId) {
            console.log("⚠️ No existing thread found. Creating a new one...");

            const threadResponse = await fetch("https://api.openai.com/v1/threads", {
                method: "POST",
                headers: OPENAI_HEADERS,
                body: JSON.stringify({ metadata: { participantId } }),
                timeout: 60000,
            });

            const threadData = await threadResponse.json();
            if (!threadData.id) {
                console.error("❌ Failed to create new thread.");
                return res.status(500).json({ error: "Could not create a new thread." });
            }

            thread = new Thread({
                threadId: threadData.id,
                participantId,
                createdAt: new Date(),
                messages: []
            });

            await thread.save();
            console.log(`✅ New Thread created for Participant ID: ${participantId}`);
        }

        let threadId = thread.threadId;
        console.log(`✅ Using thread: ${threadId}`);

        // Updated prompt including the current description
        let prompt = `The visitor with the "${profile}" profile wants to learn more about the "${artefact}" artefact. They have already seen the following description:\n"${currentDescription}"\n\nPlease provide additional, non-redundant information that expands on the artefact. The new content should remain engaging, accurate, and tailored to the visitor’s profile preferences without explicitly referencing their profile or repeating previous details. If no significant new information is available, offer a subtle acknowledgment of that while maintaining an informative tone.`;

        console.log(`📝 Sending additional prompt to Assistant:\n${prompt}`);

        // Save the user's additional prompt to the thread before sending it
        thread.messages.push({
            role: "user",
            content: prompt,
            timestamp: new Date()
        });

        await thread.save();
        console.log("✅ Additional user prompt saved to thread.");

        // Send prompt to assistant
        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ role: "user", content: prompt }),
            timeout: 60000,
        });

        const messageData = await messageResponse.json();
        if (!messageData.id) throw new Error("Failed to add message");

        console.log("▶️ Running Assistant for additional info...");
        const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
            timeout: 60000,
        });

        const runData = await runResponse.json();
        if (!runData.id) throw new Error("Failed to run assistant");

        const runId = runData.id;
        console.log(`✅ Additional Info Run ID: ${runId}, Participant ID: ${participantId}`);

        let status = "in_progress";
        let responseContent = "";

        while (status === "in_progress" || status === "queued") {
            await new Promise(resolve => setTimeout(resolve, 3000));

            const checkRunResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
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

                // Save assistant's response to the thread
                thread.messages.push({
                    role: "assistant",
                    content: responseContent,
                    timestamp: new Date()
                });

                await thread.save();
                console.log("✅ Additional assistant response saved to thread.");
                break;
            }
        }

        res.json({ response: responseContent });

    } catch (error) {
        console.error("❌ Error fetching additional info:", error);
        res.status(500).json({ response: "Failed to fetch additional information." });
    }
});

// API route for fetching TTS audio
app.post("/fetch-tts", async (req, res) => {
    const { text } = req.body;

    if (!text) {
        console.error("❌ Missing text input for TTS");
        return res.status(400).json({ error: "Missing text input for TTS" });
    }

    try {
        const audioBuffer = await fetchTTSWithRetry(text);

        if (!audioBuffer) {
            console.error("❌ No audio buffer received.");
            return res.status(500).json({ error: "Failed to generate TTS audio" });
        }

        res.set({
            "Content-Type": "audio/mpeg",
            "Content-Length": audioBuffer.length,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        });

        res.send(audioBuffer);
    } catch (error) {
        console.error("❌ Error fetching TTS:", error.message);
        res.status(500).json({ error: "Failed to generate TTS audio. Please try again later." });
    }
});

// Function to fetch TTS with automatic retries
async function fetchTTSWithRetry(text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Sending Text-to-Speech Request (Attempt ${i + 1})...`);

            const response = await fetch("https://api.openai.com/v1/audio/speech", {
                method: "POST",
                headers: OPENAI_HEADERS,
                body: JSON.stringify({
                    model: "tts-1",
                    input: text,
                    voice: "nova",
                }),
                timeout: 90000,  // ⏳ Increased timeout to 90 seconds
            });

            if (!response.ok) throw new Error(`Failed to generate audio: ${response.statusText}`);

            const audioBuffer = await response.arrayBuffer();
            console.log("🔊 TTS Audio successfully generated!");
            return Buffer.from(audioBuffer);
        } catch (error) {
            console.error(`❌ TTS attempt ${i + 1} failed:`, error.message);
            if (i === retries - 1) {
                console.error("🚨 TTS service unavailable after multiple retries.");
                throw error;
            }
            await new Promise(res => setTimeout(res, 3000)); // ⏳ Wait before retrying
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

/* Developed by Harun Hurtic as part of his Master's Thesis at the Norwegian University of Science and Technology (NTNU) */