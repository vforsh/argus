export const BUILTIN_PLUGIN_ALIASES: Record<string, string> = {
	gsheets: '@vforsh/argus-plugin-google-sheets',
	gs: '@vforsh/argus-plugin-google-sheets',
}

export const resolvePluginAlias = (spec: string, aliases: Record<string, string>): { spec: string; alias: string | null } => {
	const trimmed = spec.trim()
	const resolved = aliases[trimmed]
	return resolved ? { spec: resolved, alias: trimmed } : { spec: trimmed, alias: null }
}
