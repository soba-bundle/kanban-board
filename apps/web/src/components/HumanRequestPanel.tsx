import { useState } from "react";
import type { HumanRequest, HumanRequestAnswerInput } from "@kanban-board/shared";

interface HumanRequestPanelProps {
  request: HumanRequest;
  busy?: boolean;
  error?: string | null;
  onAnswer: (answers: HumanRequestAnswerInput[]) => void;
  onStop: () => void;
}

export function HumanRequestPanel({ request, busy = false, error, onAnswer, onStop }: HumanRequestPanelProps) {
  const [activeTab, setActiveTab] = useState(request.questions[0]?.id ?? "review");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, boolean>>({});
  const pending = request.status === "PENDING";

  if (!pending) {
    const cancelled = request.status === "CANCELLED";
    return (
      <section className={`human-request-card human-request-terminal${cancelled ? " human-request-cancelled" : " human-request-answered"}`}>
        <header className="human-request-header">
          <strong>Human Request</strong>
          <span>{cancelled ? "Cancelled" : "Answered"}</span>
        </header>
        {cancelled
          ? <p>No answers were submitted. The run was stopped.</p>
          : <ul className="human-request-answers">{(request.answers ?? []).map((answer) => {
            const question = request.questions.find((item) => item.id === answer.id);
            return <li key={answer.id}><strong>{question?.label ?? answer.id}:</strong> {answer.value}</li>;
          })}</ul>}
      </section>
    );
  }

  const isComplete = (id: string) => {
    const question = request.questions.find((item) => item.id === id);
    const value = customAnswers[id] ? drafts[id]?.trim() ?? "" : selectedOptions[id] ?? "";
    if (!question || !value) return false;
    return customAnswers[id]
      ? question.allowOther
      : question.options.some((option) => option.value === value);
  };
  const completeCount = request.questions.filter((question) => isComplete(question.id)).length;
  const allComplete = completeCount === request.questions.length;
  const activeQuestion = request.questions.find((question) => question.id === activeTab);

  return (
    <section className="human-request-card" aria-labelledby={`human-request-title-${request.id}`}>
      <header className="human-request-header">
        <div>
          <p className="ticket-section-title">Needs your input</p>
          <h3 id={`human-request-title-${request.id}`}>Human Request</h3>
        </div>
        <span>{completeCount}/{request.questions.length} answered</span>
      </header>
      <nav className="human-request-tabs" aria-label="Human Request questions" role="tablist">
        {request.questions.map((question) => (
          <button key={question.id} id={`human-request-tab-${request.id}-${question.id}`} type="button" role="tab"
            aria-selected={activeTab === question.id} aria-controls={`human-request-panel-${request.id}`}
            className={activeTab === question.id ? "human-request-tab human-request-tab-active" : "human-request-tab"}
            onClick={() => setActiveTab(question.id)}>
            {question.label}{isComplete(question.id) ? " ✓" : ""}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={activeTab === "review"}
          aria-disabled={!allComplete} aria-controls={`human-request-panel-${request.id}`}
          className={activeTab === "review" ? "human-request-tab human-request-tab-active" : "human-request-tab"}
          disabled={!allComplete} onClick={() => setActiveTab("review")}>Review and submit</button>
      </nav>

      <div id={`human-request-panel-${request.id}`} className="human-request-content" role="tabpanel"
        aria-labelledby={activeTab === "review" ? undefined : `human-request-tab-${request.id}-${activeTab}`}>
        {activeQuestion ? (
          <>
            <p className="human-request-prompt">{activeQuestion.prompt}</p>
            <fieldset className="human-request-options" disabled={busy}>
              <legend className="visually-hidden">{activeQuestion.label}</legend>
              {activeQuestion.options.map((option) => (
                <label className="human-request-option" key={option.value}>
                  <input type="radio" name={`human-request-${request.id}-${activeQuestion.id}`}
                    checked={!customAnswers[activeQuestion.id] && selectedOptions[activeQuestion.id] === option.value}
                    onChange={() => {
                      setSelectedOptions((current) => ({ ...current, [activeQuestion.id]: option.value }));
                      setCustomAnswers((current) => ({ ...current, [activeQuestion.id]: false }));
                    }} />
                  <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                </label>
              ))}
              {activeQuestion.allowOther && (
                <div className="human-request-custom">
                  <label className="human-request-option">
                    <input type="radio" name={`human-request-${request.id}-${activeQuestion.id}`}
                      checked={!!customAnswers[activeQuestion.id]}
                      onChange={() => setCustomAnswers((current) => ({ ...current, [activeQuestion.id]: true }))} />
                    <span><strong>Type something</strong></span>
                  </label>
                  {customAnswers[activeQuestion.id] && <textarea aria-label="Your answer" rows={2}
                    value={drafts[activeQuestion.id] ?? ""} disabled={busy}
                    onChange={(event) => setDrafts((current) => ({ ...current, [activeQuestion.id]: event.target.value }))} />}
                </div>
              )}
            </fieldset>
          </>
        ) : (
          <>
            <p className="human-request-prompt">Review your answers before sending them together.</p>
            <ul className="human-request-review-list">
              {request.questions.map((question) => {
                const value = customAnswers[question.id] ? drafts[question.id] ?? "" : selectedOptions[question.id] ?? "";
                const option = customAnswers[question.id] ? undefined : question.options.find((item) => item.value === value);
                return <li key={question.id}>
                  <div><strong>{question.label}</strong><p>{option?.label ?? value}</p></div>
                  <button type="button" className="link-button" onClick={() => setActiveTab(question.id)}>Edit</button>
                </li>;
              })}
            </ul>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="human-request-actions">
              <button type="button" className="button-primary" disabled={busy || !allComplete}
                onClick={() => onAnswer(request.questions.map((question) => ({
                  id: question.id,
                  value: (customAnswers[question.id] ? drafts[question.id] : selectedOptions[question.id])!.trim(),
                })))}>
                {busy ? "Submitting…" : "Submit answers"}
              </button>
            </div>
          </>
        )}
      </div>
      {error && activeQuestion && <p className="error" role="alert">{error}</p>}
      <footer className="human-request-footer">
        <span>Answers are submitted together; Stop sends none of them.</span>
        <button type="button" className="button-quiet link-danger" disabled={busy} onClick={onStop}>Stop waiting</button>
      </footer>
    </section>
  );
}
