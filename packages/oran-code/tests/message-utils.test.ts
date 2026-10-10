import { describe, expect, it } from "vitest";
import { stripPlanCompleteMarkers } from "../src/message-utils.js";

describe("plan completion markers", () => {
  it("removes the bracketed marker whole, punctuation included", () => {
    // The bare "PLAN_COMPLETE" is a prefix of "<<PLAN_COMPLETE>>", and it used to be
    // removed first: the transcript showed "<<>>" where the marker had been.
    expect(stripPlanCompleteMarkers("done\n<<PLAN_COMPLETE>>\n")).toBe("done");
    expect(stripPlanCompleteMarkers("done\nPLAN_COMPLETE\n")).toBe("done");
    expect(stripPlanCompleteMarkers("done\n<plan_complete>\n")).toBe("done");
  });

  it("leaves ordinary text alone", () => {
    expect(stripPlanCompleteMarkers("the plan is complete, next step is the patch")).toBe(
      "the plan is complete, next step is the patch",
    );
  });
});
