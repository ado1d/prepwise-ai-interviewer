"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Upload, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface AdvancedPreferencesProps {
  /** Current preference values (controlled). */
  values: InterviewPreferences;
  /** Called whenever any preference value changes. */
  onChange: (next: InterviewPreferences) => void;
  /** Disables all inputs while a call is in progress. */
  disabled?: boolean;
}

// Accept PDFs plus common plain-text resume formats. PDF is parsed
// server-side via /api/parse-resume (unpdf); text files can be read either
// server-side or client-side, but we always send them to the route so the
// behaviour and limits are consistent.
const ACCEPTED_EXTENSIONS = ".pdf,.txt,.md,.markdown,text/*";

const MAX_RESUME_CHARS = 8000;

/**
 * Optional "advanced preferences" panel shown above the call button on the
 * generate (interview-setup) screen.
 *
 * Strictly additive: if the user leaves everything blank, the flow behaves
 * exactly as before. Every field is optional and only influences the
 * generated interview (it never blocks the call).
 */
const AdvancedPreferences = ({
  values,
  onChange,
  disabled = false,
}: AdvancedPreferencesProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const update = (patch: Partial<InterviewPreferences>) => {
    onChange({ ...values, ...patch });
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset the input so the same file can be re-picked after an error.
    if (fileInputRef.current) fileInputRef.current.value = "";

    setFileError(null);
    setParsing(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/parse-resume", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setFileError(
          data.error ||
            "Could not read that file. Try a different file or paste the text manually."
        );
        setFileName(null);
        return;
      }

      update({ resumeText: data.text });
      setFileName(data.name || file.name);
    } catch {
      setFileError(
        "Something went wrong while reading the file. Please paste the resume text manually instead."
      );
      setFileName(null);
    } finally {
      setParsing(false);
    }
  };

  const clearResume = () => {
    update({ resumeText: "" });
    setFileName(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="card-border w-full">
      <div className="card flex flex-col gap-6 p-6">
        <div className="flex flex-col gap-1">
          <h3 className="text-primary-100">Advanced preferences</h3>
          <p className="text-sm text-light-400">
            Optional. Tailor the interview before it starts. Leave blank to keep
            the default experience.
          </p>
        </div>

        {/* Interview type */}
        <div className="form">
          <label htmlFor="pref-interview-type" className="label">
            Interview type
          </label>
          <input
            id="pref-interview-type"
            type="text"
            className="input"
            placeholder="e.g. Technical round, HR screening, Behavioral, System design"
            value={values.interviewType ?? ""}
            disabled={disabled}
            onChange={(e) => update({ interviewType: e.target.value })}
          />
        </div>

        {/* Question preference */}
        <div className="form">
          <label htmlFor="pref-question-type" className="label">
            Question preference
          </label>
          <textarea
            id="pref-question-type"
            className="bg-dark-200 rounded-2xl min-h-24 w-full px-5 py-3 resize-y placeholder:text-light-400 text-light-100 focus:outline-none border border-input"
            placeholder="What kind of questions do you want to face? e.g. focus on React hooks, DSA, leadership scenarios, past-project deep dives..."
            value={values.questionPreference ?? ""}
            disabled={disabled}
            onChange={(e) => update({ questionPreference: e.target.value })}
          />
        </div>

        {/* CV / resume */}
        <div className="form">
          <label className="label">CV / Resume (optional)</label>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={cn(
                  "btn-upload",
                  "flex items-center justify-center gap-2",
                  parsing && "opacity-60 cursor-wait"
                )}
                disabled={disabled || parsing}
                onClick={() => fileInputRef.current?.click()}
              >
                {parsing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                <span className="text-sm font-medium">
                  {parsing
                    ? "Reading..."
                    : fileName
                      ? fileName
                      : "Upload PDF / TXT / MD"}
                </span>
              </button>

              {fileName && !parsing && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-light-400 hover:text-light-100 transition-colors"
                  disabled={disabled}
                  onClick={clearResume}
                >
                  <X className="size-3" /> Remove
                </button>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_EXTENSIONS}
                className="hidden"
                disabled={disabled || parsing}
                onChange={handleFileChange}
              />
            </div>

            <textarea
              className="bg-dark-200 rounded-2xl min-h-32 w-full px-5 py-3 resize-y placeholder:text-light-400 text-light-100 focus:outline-none border border-input"
              placeholder={
                "Or paste your resume text here. You can also upload a PDF above and the extracted text will appear here for you to review."
              }
              value={values.resumeText ?? ""}
              disabled={disabled}
              maxLength={MAX_RESUME_CHARS}
              onChange={(e) => {
                update({ resumeText: e.target.value });
                // Editing the text manually detaches it from the uploaded file.
                setFileName(null);
              }}
            />

            <div className="flex items-center justify-between text-xs text-light-400">
              <span className="inline-flex items-center gap-1">
                <FileText className="size-3" />
                {values.resumeText
                  ? `${values.resumeText.length.toLocaleString()} chars captured`
                  : "No resume text yet"}
              </span>
              <span>{MAX_RESUME_CHARS.toLocaleString()} char max</span>
            </div>

            {fileError && (
              <p className="text-xs text-destructive-100">{fileError}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdvancedPreferences;
