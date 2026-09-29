"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// backend/src/metadata/metadata-merge.ts
var metadata_merge_exports = {};
__export(metadata_merge_exports, {
  DURATION_SOURCE_ORDER: () => DURATION_SOURCE_ORDER,
  DURATION_SOURCE_PRIORITY: () => DURATION_SOURCE_PRIORITY,
  hasMetascore: () => hasMetascore,
  mergeDuration: () => mergeDuration,
  mergeRatings: () => mergeRatings,
  parseJson: () => parseJson
});
module.exports = __toCommonJS(metadata_merge_exports);
var DURATION_SOURCE_PRIORITY = { hltb: 2, rawg: 1 };
var DURATION_SOURCE_ORDER = Object.entries(DURATION_SOURCE_PRIORITY).sort((a, b) => b[1] - a[1]).map(([name]) => name);
function parseJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function hasMetascore(ratingsJson) {
  return parseJson(ratingsJson ?? "[]").some((r) => r.metascore != null);
}
function mergeRatings(existingJson, incoming) {
  const existing = parseJson(existingJson ?? "[]");
  if (!incoming) return existingJson;
  const incomingHasValue = incoming.metascore != null || incoming.userScore != null || incoming.criticCount != null || incoming.userCount != null;
  if (!incomingHasValue) return existingJson;
  const index = existing.findIndex((r) => r.source === incoming.source);
  if (index === -1) return JSON.stringify([...existing, incoming]);
  const prev = existing[index];
  const merged = {
    ...prev,
    ...incoming,
    metascore: incoming.metascore ?? prev.metascore ?? null,
    userScore: incoming.userScore ?? prev.userScore ?? null,
    criticCount: incoming.criticCount ?? prev.criticCount ?? null,
    userCount: incoming.userCount ?? prev.userCount ?? null,
    ratingClass: incoming.ratingClass ?? prev.ratingClass ?? null
  };
  const next = [...existing];
  next[index] = merged;
  return JSON.stringify(next);
}
function mergeDuration(stored, fragment) {
  const current = {
    main_story_hours: stored?.main_story_hours ?? null,
    main_extra_hours: stored?.main_extra_hours ?? null,
    completionist_hours: stored?.completionist_hours ?? null,
    duration_source: stored?.duration_source ?? null
  };
  const incomingSource = fragment.durationSource ?? null;
  const hasIncoming = fragment.mainStoryHours != null || fragment.mainExtraHours != null || fragment.completionistHours != null;
  if (!hasIncoming) return current;
  const incomingRank = incomingSource ? DURATION_SOURCE_PRIORITY[incomingSource] ?? 0 : 0;
  const storedRank = current.duration_source ? DURATION_SOURCE_PRIORITY[current.duration_source] ?? 0 : -1;
  if (incomingRank >= storedRank) {
    return {
      main_story_hours: fragment.mainStoryHours ?? current.main_story_hours,
      main_extra_hours: fragment.mainExtraHours ?? current.main_extra_hours,
      completionist_hours: fragment.completionistHours ?? current.completionist_hours,
      duration_source: incomingSource ?? current.duration_source
    };
  }
  const filled = {
    main_story_hours: current.main_story_hours ?? fragment.mainStoryHours ?? null,
    main_extra_hours: current.main_extra_hours ?? fragment.mainExtraHours ?? null,
    completionist_hours: current.completionist_hours ?? fragment.completionistHours ?? null,
    duration_source: current.duration_source
  };
  const contributed = filled.main_story_hours !== current.main_story_hours || filled.main_extra_hours !== current.main_extra_hours || filled.completionist_hours !== current.completionist_hours;
  if (contributed && !filled.duration_source) filled.duration_source = incomingSource;
  return filled;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DURATION_SOURCE_ORDER,
  DURATION_SOURCE_PRIORITY,
  hasMetascore,
  mergeDuration,
  mergeRatings,
  parseJson
});
