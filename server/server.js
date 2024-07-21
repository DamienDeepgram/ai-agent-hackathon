// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require('uuid');
dotenv.config();

// Twilio
const twilio = require("twilio");
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const NGROK_URL = process.env.NGROK_URL;
const client = twilio(accountSid, authToken);

const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest); // Create HTTP server to handle requests

const HTTP_SERVER_PORT = 8080; // Define the server port
let streamSid = ''; // Variable to store stream session ID

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

const pendingResponses = {};
let currentCallId = null;
let currentCall = null;
let callGoal = '';

// Deepgram Speech to Text
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();

// Deepgram Text to Speech Websocket
const WebSocket = require('ws');
const deepgramTTSWebsocketURL = 'wss://api.beta.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none';

// Performance Timings
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"]

// Function to handle HTTP requests
function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

/*
 Easy Debug Endpoint
*/
dispatcher.onGet("/", function (req, res) {
  console.log('GET /');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, World!');
});

/*
 Twilio streams.xml
*/
dispatcher.onPost("/twiml", function (req, res) {
  let filePath = path.join(__dirname + "/templates", "streams.xml");
  let stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size,
  });

  let readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

/* 
  Friend Webhook 
*/
dispatcher.onPost("/webhook", async function (req, res) {
  // console.log('\nGET /webhook');

  const payload = req.body;
  const requestId = currentCallId;

  // Log the payload for debugging purposes
  console.log('Twilio: Call Ended.');

  // Check if we have a pending response for this requestId
  if (pendingResponses[requestId]) {
    // Get the stored response object
    const originalRes = pendingResponses[requestId].res;
    const transcript = pendingResponses[requestId].transcript;

    originalRes.writeHead(200, { 'Content-Type': 'application/json' });
    originalRes.end(JSON.stringify({ transcript: transcript }));

    // Remove the entry from the map
    pendingResponses[requestId] = null;
  } else {
    console.log('Unable to find call');
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Webhook processed' }));
});

/*
 Twilio Make Call
*/
dispatcher.onPost("/call", async function (req, res) {
  console.log('GET /call');
  let toNumber = JSON.parse(req.body).number;
  if(toNumber){
    toNumber = toNumber.replaceAll('(', '').replaceAll(')', '').replaceAll('-', '').replaceAll(' ', '').replaceAll('\n', '');
  }
  const goal = JSON.parse(req.body).goal;
  console.log('goal:', goal);
  await createCall(toNumber, goal);
  // Custom Number for debuggin
  // await createCall("+1415xxxxxxx");

  const requestId = uuidv4();
  currentCallId = requestId;
  pendingResponses[currentCallId] = {
    res,
    transcript: '',
    goal
  }
  // console.log('Waiting for call to end');
});

async function createCall(toNumber) {
  console.log('Calling: [' + toNumber + ']...');
  try{
    currentCall = await client.calls.create({
      from: fromPhoneNumber,
      statusCallback: NGROK_URL + "/webhook",
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
      to: toNumber,
      url: NGROK_URL + "/twiml",
    });
  } catch(err){
    console.log('Error making call:', err);
  }

  // console.log(currentCall.sid);
}

/*
  Websocket Server
*/
mediaws.on("connect", function (connection) {
  // console.log("Twilio: Connection accepted");
  new MediaStream(connection);
});

/*
  Twilio Bi-directional Streaming
*/
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramWebsocket(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;
  }

  // Function to process incoming messages
  async processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        console.log("Twilio: Call Connected");
        // console.log("Twilio: Connected event received: ", data);

        const recording = await client
        .calls(currentCall.sid)
        .recordings.create();
      }
      if (data.event === "start") {
        // console.log("Twilio: Start event received: ", data);
        console.log("Twilio: Call Started");
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          // console.log("Twilio: Media event received: ", data);
          // console.log("Twilio: Suppressing additional messages...");
          this.hasSeenMedia = true;
        }
        if (!streamSid) {
          // console.log('Twilio: streamSid=', streamSid);
          streamSid = data.streamSid;
        }
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          this.deepgram.send(rawAudio);
        }
      }
      if (data.event === "mark") {
        console.log("Twilio: Mark event received", data);
      }
      if (data.event === "close") {
        console.log("Twilio: Close event received: ", data);
        this.close();
      }
    } else if (message.type === "binary") {
      console.log("Twilio: binary message received (not supported)");
    }
  }

  // Function to handle connection close
  close() {
    // console.log("Twilio: Closed");
  }
}

/*
  OpenAI Streaming LLM
*/
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: 'gpt-4o-mini',
    stream: true,
    messages: [
      {
        role: 'assistant',
        content: `
        You are making an outbound phonecall. 
        Goal: You are calling a store to ${pendingResponses[currentCallId].goal}. 
        If you need to follow instructions to navigate a phone menu do so. 
        Do not break character. 
        Keep your responses short 1-2 sentences.
        Do not say you will call the store to verify, you are already talking to the store.
        Do not enagage in any other activities and once you have completed your goal reply with these EXACT words ONLY: "Thank you for your help... goodbye."`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
  });

  speaking = true;
  let firstToken = true;
  let speech = '';
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        const end = Date.now();
        const duration = end - llmStart;
        ttsStart = Date.now();
        // console.warn('\n>>> openai LLM: Time to First Token = ', duration, '\n');
        firstToken = false;
        firstByte = true;
      }
      chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)){
          send_first_sentence_input_time = Date.now();
        }
        speech += chunk_message;
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Speak', 'text': chunk_message }));

        if(chunk_message.toLowerCase().indexOf('goodbye') != -1){
          setTimeout(()=>{
            currentCall.update({ status: "completed" });
          }, 7000)
        }
      }
    }
  }
  console.log("[AI Bot]", speech);
  // Tell TTS Websocket were finished generation of tokens
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
}

function containsAnyChars(str) {
  // Convert the string to an array of characters
  let strArray = Array.from(str);
  
  // Check if any character in strArray exists in chars_to_check
  return strArray.some(char => chars_to_check.includes(char));
}

/*
  Deepgram Streaming Text to Speech
*/
const setupDeepgramWebsocket = (mediaStream) => {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('open', function open() {
    console.log('Deepgram Text to Speech: Connected');
  });

  ws.on('message', function incoming(data) {
    // Handles barge in
    if (speaking) {
      try {
        let json = JSON.parse(data.toString());
        // console.log('deepgram TTS: ', data.toString());
        return;
      } catch (e) {
        // Ignore
      }
      if (firstByte) {
        const end = Date.now();
        const duration = end - ttsStart;
        // console.warn('\n\n>>> deepgram TTS: Time to First Byte = ', duration, '\n');
        firstByte = false;
        if (send_first_sentence_input_time){
          // console.log(`>>> deepgram TTS: Time to First Byte from end of sentence token = `, (end - send_first_sentence_input_time));
        }
      }
      const payload = data.toString('base64');
      const message = {
        event: 'media',
        streamSid: streamSid,
        media: {
          payload,
        },
      };
      const messageJSON = JSON.stringify(message);

      // console.log('\ndeepgram TTS: Sending data.length:', data.length);
      mediaStream.connection.sendUTF(messageJSON);
    }
  });

  ws.on('close', function close() {
    console.log('deepgram TTS: Disconnected from the WebSocket server');
  });

  ws.on('error', function error(error) {
    console.log("deepgram TTS: error received");
    console.error(error);
  });
  return ws;
}

/*
  Deepgram Streaming Speech to Text
*/
const setupDeepgram = (mediaStream) => {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    // Model
    model: "nova-2-phonecall",
    language: "en",
    // Formatting
    smart_format: true,
    // Audio
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
    // End of Speech
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive(); // Keeps the connection alive
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("Deepgram Speech to Text: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`[Person FINSIHED] ${utterance}`);
            llmStart = Date.now();
            pendingResponses[currentCallId].transcript += utterance + ' ';
            promptLLM(mediaStream, utterance, pendingResponses[currentCallId].goal); // Send the final transcript to OpenAI for response
          } 
          // else {
          //   console.log(`deepgram STT:  [Is Final] ${transcript}`);
          // }
        } else {
          console.log(`[Person SPEAKING] ${transcript}`);
          if (speaking) {
            // console.log('Twilio: clear audio playback', streamSid);
            // Handles Barge In
            const messageJSON = JSON.stringify({
              "event": "clear",
              "streamSid": streamSid,
            });
            mediaStream.connection.sendUTF(messageJSON);
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Reset' }));
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        // console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`[Person] ${utterance}`);
        llmStart = Date.now();
        pendingResponses[currentCallId].transcript += utterance + ' ';
        promptLLM(mediaStream, utterance, pendingResponses[currentCallId].goal);
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram STT: disconnected");
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram STT: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      // console.log("deepgram STT: metadata received:", data);
    });
  });

  return deepgram;
};

wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
