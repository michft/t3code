import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

describe("ComposerPendingUserInputPanel", () => {
  it("renders numbered options and question quick answers", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: ApprovalRequestId.make("question-1"),
            createdAt: "2026-07-21T00:00:00.000Z",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which approach should the plan use?",
                options: [
                  {
                    label: "Narrow change (Recommended)",
                    description: "Keep the implementation focused.",
                  },
                  {
                    label: "Broad change",
                    description: "Update adjacent workflows too.",
                  },
                ],
                multiSelect: false,
              },
            ],
          },
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => undefined}
        onSubmitQuickAnswer={() => undefined}
        onAdvance={() => undefined}
      />,
    );

    expect(markup).toContain(">1</kbd>");
    expect(markup).toContain(">2</kbd>");
    expect(markup).toContain('aria-label="Accept recommended answer"');
    expect(markup).toContain('aria-label="Try question again with different options"');
    expect(markup).toContain('aria-label="Ask question with more detail"');
    expect(markup).toContain('aria-label="Ask question with less detail"');
  });
});
