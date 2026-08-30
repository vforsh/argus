/**
 * Native Messaging protocol types for the Chrome extension.
 *
 * The contract itself lives in `@vforsh/argus-core/native-messaging` so both peers
 * compile against one definition; this module only re-exports it under the path the
 * extension's own code imports. Types erase at bundle time and the version constant
 * inlines, so the extension keeps its no-runtime-dependencies property.
 */
export * from '@vforsh/argus-core/native-messaging'
