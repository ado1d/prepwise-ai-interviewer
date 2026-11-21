"use client";

import { useState } from "react";

import Agent from "@/components/Agent";
import AdvancedPreferences from "@/components/AdvancedPreferences";

interface InterviewGeneratorProps {
  userName: string;
  userId?: string;
}

/**
 * Client wrapper for the "generate" interview-setup screen.
 *
 * It owns the optional advanced-preferences state (interview type, question
 * preference, CV/resume text) and forwards it to the <Agent>. The Agent in
 * turn sends it to /api/realtime-session (system instructions) and to
 * /api/interviews (question generation).
 *
 * Strictly additive: if the user leaves every preference blank, the Agent
 * behaves exactly as it did before this feature existed.
 */
const InterviewGenerator = ({ userName, userId }: InterviewGeneratorProps) => {
  const [preferences, setPreferences] = useState<InterviewPreferences>({});
  // Disable the form once a call is connecting/active so the user cannot edit
  // preferences mid-session. The Agent itself controls the call status; we
  // mirror it here via a lightweight callback.
  const [callActive, setCallActive] = useState(false);

  return (
    <>
      <h3>Interview generation</h3>

      <AdvancedPreferences
        values={preferences}
        onChange={setPreferences}
        disabled={callActive}
      />

      <Agent
        userName={userName}
        userId={userId}
        type="generate"
        preferences={preferences}
        onCallStateChange={setCallActive}
      />
    </>
  );
};

export default InterviewGenerator;
