import { describe, expect, it } from "vitest";

import { getMentionSuggestions } from "./AIChatMentionPicker";

describe("AIChatMentionPicker", () => {
    it("does not include plan mode in @ suggestions", () => {
        expect(getMentionSuggestions("", [])).toEqual([{ kind: "fetch" }]);
        expect(getMentionSuggestions("pl", [])).toEqual([]);
    });
});
