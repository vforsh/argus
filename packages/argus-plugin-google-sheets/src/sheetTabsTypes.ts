/** Visible Google Sheets tab metadata. */
export type SheetTab = { index: number; name: string; gid: string | null; active: boolean }

/** Metadata that always describes the intended target sheet. */
export type SheetTargetMetadata = { name: string; index: number; gid: string; url: string }

/** Metadata that explicitly describes browser state before/after restoration. */
export type SheetBrowserMetadata = { currentGid: string; currentUrl: string; restoredGid?: string; restoredUrl?: string }

type SheetPageResult = { ok: true; title: string; url: string }

/** Visible sheet list result. */
export type SheetListResult = SheetPageResult & { activeGid: string; sheets: SheetTab[] }

/** Spreadsheet and visible sheet metadata. */
export type SheetInfoResult = SheetListResult & { spreadsheetId: string; active: SheetTab | null }

/** Sheet switch result. */
export type SheetSwitchResult = SheetPageResult & { sheet: SheetTab }

/** Sheet creation result. */
export type SheetAddResult = SheetPageResult & { sheet: SheetTab }

/** Sheet removal result. */
export type SheetRemoveResult = SheetPageResult & { removed: SheetTab; active: SheetTab | null }

/** Sheet rename result. */
export type SheetRenameResult = SheetPageResult & { before: SheetTab; sheet: SheetTab }

/** Sheet move result. */
export type SheetMoveResult = SheetPageResult & { before: SheetTab; sheet: SheetTab }

/** Target resolution result with separate target and restored-browser metadata. */
export type SheetResolveResult = SheetPageResult & { sheet: SheetTab; target: SheetTargetMetadata; browser: SheetBrowserMetadata }
