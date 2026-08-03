import { describe, expect, it } from "vitest";

import { buildUserInputAnswers } from "./userInputAnswers";

describe("buildUserInputAnswers", () => {
    it("routes custom answers through their ACP companion field", () => {
        expect(
            buildUserInputAnswers(
                [{ customAnswerId: "question_0_custom", id: "question_0" }],
                { question_0: ["Safe"] },
                { question_0: "Use a sandbox" },
            ),
        ).toEqual([
            { answers: ["Safe"], questionId: "question_0" },
            {
                answers: ["Use a sandbox"],
                questionId: "question_0_custom",
            },
        ]);
    });

    it("keeps legacy free text on the original question", () => {
        expect(
            buildUserInputAnswers(
                [{ customAnswerId: null, id: "question_0" }],
                { question_0: ["Safe"] },
                { question_0: "with tests" },
            ),
        ).toEqual([
            {
                answers: ["Safe", "with tests"],
                questionId: "question_0",
            },
        ]);
    });
});
