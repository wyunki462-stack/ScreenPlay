/** Dialogs: poster editor, metadata editor, platform picker, manual match, game menu. */
export const dialogsEn: Record<string, string> = {
  // PosterDialog — "Edit poster"
  "dialogs.poster.title": "Edit poster · {name}",
  "dialogs.poster.displayMode": "Homepage card slideshow",
  "dialogs.poster.modeStatic": "Static (single)",
  "dialogs.poster.modeSlideshow": "Slideshow (auto-switch)",
  "dialogs.poster.slideshowCount": "Selected {n} for the homepage card slideshow",
  "dialogs.poster.slideshowHint":
    "The 「slideshow」 ticks below choose which images join the HOMEPAGE card rotation (the current cover plus the ticked rows — unticked ones do not appear). Album screenshots start unticked; only ones you tick join. The display mode above also drives the homepage card: 「slideshow」 auto-switches it and puts prev/next arrows on the card cover, while a static cover shows no arrows. The detail page's large image always auto-rotates through every official poster and no setting here changes it.",
  "dialogs.poster.slideshowItemHint": "Tick to include this image in the homepage card slideshow; untick to remove it — it will not be added back.",
  "dialogs.poster.tabUpload": "Upload image",
  "dialogs.poster.tabAlbum": "Choose from album",
  "dialogs.poster.chooseFile": "Choose image to upload",
  "dialogs.poster.uploadHint": "Supports JPG / PNG / WebP / GIF, ≤20MB",
  "dialogs.poster.albumLoading": "Loading album images…",
  "dialogs.poster.albumEmpty": "This game has no album images to choose from.",
  "dialogs.poster.albumFilterPlaceholder": "Filter by file name among {n} album images…",
  "dialogs.poster.albumShown": "Showing {shown}/{total}",
  "dialogs.poster.albumNoMatch": "No matching images.",
  "dialogs.poster.alreadyAdded": "Already added as a poster",
  "dialogs.poster.clickToAdd": "Click to add as a poster",
  "dialogs.poster.empty": "No posters yet — add one above.",
  "dialogs.poster.sourceScraped": "Official posters (scraped)",
  "dialogs.poster.sourceUpload": "Uploaded by me",
  "dialogs.poster.sourceMedia": "Game screenshots",
  "dialogs.poster.imageCount": "{n} images",
  "dialogs.poster.imageAlt": "Poster",
  "dialogs.poster.badgeCover": "Cover",
  "dialogs.poster.badgeDefaultCover": "Default cover",
  "dialogs.poster.tagUpload": "Uploaded",
  "dialogs.poster.tagMedia": "Album",
  "dialogs.poster.tagScraped": "Scraped",
  "dialogs.poster.cancelCover": "Cancel cover",
  "dialogs.poster.cancelCoverHint": "Cancel the cover and go back to the game's official poster",
  "dialogs.poster.cancelNotice": "Custom cover cancelled — reverted to the game's official poster",
  "dialogs.poster.cancelError": "Failed to cancel the cover: {message}",
  "dialogs.poster.defaultCoverHint": "Already the game's official poster — nothing to cancel",
  "dialogs.poster.isDefault": "Already default",
  "dialogs.poster.setCover": "Set as cover",
  "dialogs.poster.setCoverHint": "Set as the card cover",
  "dialogs.poster.slideshow": "Slideshow",
  "dialogs.poster.deletePoster": "Delete this poster",
  "dialogs.poster.deleteMediaPoster": "Remove from display (can be re-added from the album)",
  "dialogs.poster.footerHint":
    "Changes apply immediately and live in the database and data volume, so they survive a container restart.",
  "dialogs.poster.done": "Done",

  // EditDialog — "Edit metadata"
  "dialogs.edit.title": "Edit metadata · {name}",
  "dialogs.edit.name": "Name",
  "dialogs.edit.namePlaceholder": "Game name",
  "dialogs.edit.platform": "Platform",
  "dialogs.edit.platformPlaceholder": "e.g. PC / PlayStation 5 / Switch",
  "dialogs.edit.hint":
    "Once edited by hand, later scans and scrapes will no longer overwrite the name/platform.",
  "dialogs.edit.saving": "Saving…",

  // PlatformDialog — "Platforms"
  "dialogs.platform.title": "Platforms · {name}",
  "dialogs.platform.hint":
    "Pick the platforms you actually play this game on (multiple allowed). This replaces the auto-detected platforms and is what the gallery's platform filter uses.",
  "dialogs.platform.clearSelection": "Clear selection (back to auto-detected platforms)",
  "dialogs.platform.autoDetected": "Using auto-detected platforms",
  "dialogs.platform.selectedCount": "{n} platforms selected",

  // MatchDialog — "Manual match"
  "dialogs.match.title": "Manual match · {name}",
  "dialogs.match.searchPlaceholder": "Search by game name (e.g. God of War Ragnarok)",
  "dialogs.match.searching": "Searching…",
  "dialogs.match.noResults": "No results — try another keyword",
  "dialogs.match.boundNoData":
    "Bound “{name}”. The old data was cleared, but no new data came back. Check that this entry is the base game (not a DLC, a bundle, or a placeholder).",
  "dialogs.match.boundNoDataReason": "Bound “{name}”. Old data cleared, but no new data was fetched: {reason}",
  "dialogs.match.boundAllFailed":
    "Bound “{name}”. Old data cleared, but every source failed: {sources}. Retry the refresh from the detail page later.",
  "dialogs.match.boundPartial":
    "Bound “{name}”: the old data was fully cleared and replaced; only these fields are absent from this source: {sources}.",
  "dialogs.match.boundSuccess": "Bound “{name}”: old data fully cleared and replaced with the new game's data.",
  "dialogs.match.matchFailed": "Match failed: {message}",
  "dialogs.match.unknownError": "Unknown error",
  "dialogs.match.listSeparator": ", ",
  "dialogs.match.binding": "Matching…",
  "dialogs.match.rebind": "Match again",

  // GameMenu — actions and the delete confirmation
  "dialogs.gameMenu.more": "More actions",
  "dialogs.gameMenu.match": "Manual match",
  "dialogs.gameMenu.refresh": "Refresh metadata",
  "dialogs.gameMenu.edit": "Edit metadata",
  "dialogs.gameMenu.deleteTitle": "Delete game",
  "dialogs.gameMenu.deleteConfirm": "Remove “{name}” from the library?",
  "dialogs.gameMenu.deleteWithFiles": "All of its local files will be deleted as well.",
  "dialogs.gameMenu.deleteKeepFiles": "Only removed from the library; local files are kept.",
  "dialogs.gameMenu.deleteFilesLabel": "Also delete the local folder and its files",
  "dialogs.gameMenu.deleting": "Deleting…",
};