import type { AiUserInputQuestion } from "@shared/ipc";

export type UserInputAnswer = {
    readonly answers: readonly string[];
    readonly questionId: string;
};

export function buildUserInputAnswers(
    questions: readonly Pick<AiUserInputQuestion, "customAnswerId" | "id">[],
    selectedOptionsByQuestionId: Readonly<
        Record<string, readonly string[]>
    >,
    freeTextByQuestionId: Readonly<Record<string, string>>,
): readonly UserInputAnswer[] {
    return questions.flatMap((question) => {
        const selectedOptions =
            selectedOptionsByQuestionId[question.id] ?? [];
        const freeText = freeTextByQuestionId[question.id]?.trim() ?? "";

        if (question.customAnswerId) {
            const answers: UserInputAnswer[] = [];
            if (selectedOptions.length > 0) {
                answers.push({
                    answers: selectedOptions,
                    questionId: question.id,
                });
            }
            if (freeText) {
                // The companion field lets the agent distinguish a custom answer from an enum value.
                answers.push({
                    answers: [freeText],
                    questionId: question.customAnswerId,
                });
            }
            return answers;
        }

        const answers = freeText
            ? [...selectedOptions, freeText]
            : [...selectedOptions];
        return answers.length > 0
            ? [{ answers, questionId: question.id }]
            : [];
    });
}
