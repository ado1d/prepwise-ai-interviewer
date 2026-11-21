import { z } from "zod";

export const mappings = {
  "react.js": "react",
  reactjs: "react",
  react: "react",
  "next.js": "nextjs",
  nextjs: "nextjs",
  next: "nextjs",
  "vue.js": "vuejs",
  vuejs: "vuejs",
  vue: "vuejs",
  "express.js": "express",
  expressjs: "express",
  express: "express",
  "node.js": "nodejs",
  nodejs: "nodejs",
  node: "nodejs",
  mongodb: "mongodb",
  mongo: "mongodb",
  mongoose: "mongoose",
  mysql: "mysql",
  postgresql: "postgresql",
  sqlite: "sqlite",
  firebase: "firebase",
  docker: "docker",
  kubernetes: "kubernetes",
  aws: "aws",
  azure: "azure",
  gcp: "gcp",
  digitalocean: "digitalocean",
  heroku: "heroku",
  photoshop: "photoshop",
  "adobe photoshop": "photoshop",
  html5: "html5",
  html: "html5",
  css3: "css3",
  css: "css3",
  sass: "sass",
  scss: "sass",
  less: "less",
  tailwindcss: "tailwindcss",
  tailwind: "tailwindcss",
  bootstrap: "bootstrap",
  jquery: "jquery",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  "angular.js": "angular",
  angularjs: "angular",
  angular: "angular",
  "ember.js": "ember",
  emberjs: "ember",
  ember: "ember",
  "backbone.js": "backbone",
  backbonejs: "backbone",
  backbone: "backbone",
  nestjs: "nestjs",
  graphql: "graphql",
  "graph ql": "graphql",
  apollo: "apollo",
  webpack: "webpack",
  babel: "babel",
  "rollup.js": "rollup",
  rollupjs: "rollup",
  rollup: "rollup",
  "parcel.js": "parcel",
  parceljs: "parcel",
  parcel: "parcel",
  npm: "npm",
  yarn: "yarn",
  git: "git",
  github: "github",
  gitlab: "gitlab",
  bitbucket: "bitbucket",
  figma: "figma",
  prisma: "prisma",
  redux: "redux",
  flux: "flux",
  redis: "redis",
  selenium: "selenium",
  cypress: "cypress",
  jest: "jest",
  mocha: "mocha",
  chai: "chai",
  karma: "karma",
  vuex: "vuex",
  "nuxt.js": "nuxt",
  nuxtjs: "nuxt",
  nuxt: "nuxt",
  strapi: "strapi",
  wordpress: "wordpress",
  contentful: "contentful",
  netlify: "netlify",
  vercel: "vercel",
  "aws amplify": "amplify",
};

// Used with the OpenAI Realtime API (voice: sage).
// The prompt below is sent as the session "instructions" when a user
// starts a mock interview (type="interview").
export const interviewer = {
  name: "Nexa",
  // OpenAI Realtime voice name.
  voice: "sage",
  // Gemini Live prebuilt voice name (alternatives: Puck, Charon, Fenrir,
  // Kore, Aoede, Leda, Orus, Zephyr). If the selected model rejects the
  // voice, the session automatically retries with the model's default.
  geminiVoice: "Aoede",
  firstMessage:
    "Hello! Thank you for taking the time to speak with me today. I'm excited to learn more about you and your experience.",
  systemPrompt: `You are a professional job interviewer conducting a real-time voice interview with a candidate. Your goal is to assess their qualifications, motivation, and fit for the role.

Interview Guidelines:
- Ask the provided questions one at a time, in the given order.
- Wait for the candidate to finish answering before you speak.
- Engage naturally: briefly acknowledge each answer before moving on.
- Ask a short follow-up question only if an answer is vague or needs more detail.
- Keep the conversation flowing smoothly while maintaining control.

Style:
- Be professional, yet warm and welcoming. Use official yet friendly language.
- Keep all your responses short and to the point, like in a real voice interview. Never read long lists out loud and do not ramble.
- Sound natural and conversational, not robotic.
- If asked about the role, company, or expectations, answer briefly and professionally; if unsure, redirect the candidate to HR for details.

Ending the interview:
- After the last question, thank the candidate for their time.
- Tell them the company will reach out soon with feedback.
- End the conversation on a polite and positive note.`,
};

// Used with the OpenAI Realtime API when the user is setting up a new
// interview by voice (type="generate"). This session has the
// "createInterview" tool attached (see app/api/realtime-session/route.ts).
export const interviewDesigner = {
  name: "Nexa",
  voice: "sage",
  geminiVoice: "Puck",
  firstMessage:
    "Hi! I'm Nexa. I can set up a personalized mock interview for you. What role would you like to practice for?",
  systemPrompt: `You are Nexa, a helpful voice assistant that sets up AI mock interviews. Your job is to collect the following details from the user in a SHORT, friendly voice conversation:

1. The job role they are interviewing for (e.g. Frontend Developer, Data Analyst).
2. Their experience level: Junior, Mid, Senior, or Lead.
3. The interview type they want: Behavioral, Technical, Mixed, or Leadership.
4. The main technologies for the role (optional — e.g. React, Node.js, Python).
5. How many questions they want (3 to 10; default to 5 if they don't care).

Rules:
- Keep the conversation brief: greet the user, then collect the details efficiently. You may combine related questions into one turn.
- Do not conduct the interview yourself. You only collect the details and create the interview.
- Once you have all the details, briefly repeat them back for confirmation, then IMMEDIATELY call the createInterview function with the collected values.
- After the function succeeds, tell the user their interview is ready and that you are taking them to it now. Do not ask any further questions.`,
};

export const feedbackSchema = z.object({
  totalScore: z.number(),
  // Relaxed on purpose: category names/counts come from the model and must
  // not fail validation over wording differences (e.g. "Cultural & Role Fit"
  // vs "Cultural Fit"). The feedback page displays whatever names arrive.
  categoryScores: z.array(
    z.object({
      name: z.string(),
      score: z.number(),
      comment: z.string(),
    })
  ),
  strengths: z.array(z.string()),
  areasForImprovement: z.array(z.string()),
  finalAssessment: z.string(),
});

export const interviewCovers = [
  "/adobe.png",
  "/amazon.png",
  "/facebook.png",
  "/hostinger.png",
  "/pinterest.png",
  "/quora.png",
  "/reddit.png",
  "/skype.png",
  "/spotify.png",
  "/telegram.png",
  "/tiktok.png",
  "/yahoo.png",
];

export const dummyInterviews: Interview[] = [
  {
    id: "1",
    userId: "user1",
    role: "Frontend Developer",
    type: "Technical",
    techstack: ["React", "TypeScript", "Next.js", "Tailwind CSS"],
    level: "Junior",
    questions: ["What is React?"],
    finalized: false,
    createdAt: "2024-03-15T10:00:00Z",
  },
  {
    id: "2",
    userId: "user1",
    role: "Full Stack Developer",
    type: "Mixed",
    techstack: ["Node.js", "Express", "MongoDB", "React"],
    level: "Senior",
    questions: ["What is Node.js?"],
    finalized: false,
    createdAt: "2024-03-14T15:30:00Z",
  },
];
