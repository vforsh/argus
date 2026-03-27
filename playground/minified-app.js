window.minifiedFixture = {
	api: { showLogsByHost: '/admin/api/showLogsByHost', getProjects: '/admin/api/getProjects' },
	names: ['showLogsByHost', 'getProjects'],
	keys: ['playground:feature.flag', 'playground.mode'],
	message: 'Minified fixture ready for Argus',
}
window.minifiedFixture.ready = function () {
	return window.minifiedFixture.api.showLogsByHost
}
