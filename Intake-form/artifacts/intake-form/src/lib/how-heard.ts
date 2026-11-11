// Consultation "How did you hear about DrSnip?" option set (multi-select,
// captured as string[]). The option label IS the stored value — there is no
// separate key — so renaming an option changes what new submissions store.
//
// Phase 6 (C5): "Family" and "Friend" merged into "Family / Friend"; TV
// Commercial / Insurance Directory / Magazine Ad added. "Other" stays last so
// its reveal keeps keying on that value.
// 2026-11-12 (client request): "Radio" now reads "Podcast / Radio". Historical
// rows keep "Radio"; reporting folds them into the new bucket at read time
// (api/_lib/how-heard.ts). Keep the two files in step — a test checks it.
export const HOW_HEARD: string[] = [
  "Family / Friend",
  "Medical Professional Referral",
  "Facebook",
  "Instagram",
  "Google",
  "AI Search/Assistant",
  "Brochure",
  "Event",
  "Podcast / Radio",
  "TV Commercial",
  "Streaming Ad",
  "Insurance Directory",
  "Magazine Ad",
  "Other",
];
