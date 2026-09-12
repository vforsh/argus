/** Quote a literal for the POSIX shell used by Chrome's native-host wrapper. */
export const quoteNativeShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Shell-side evidence works even if Node/the CLI cannot start. Only fixed categories reach disk;
 * stderr stays on stderr and stdout remains exclusively the native-messaging framing stream.
 */
export function nativeHostDiagnosticsScript(role: 'control' | 'tab', command: string): string {
	return `umask 077
argus_incident_dir="\${ARGUS_HOME:-$HOME/.argus}/incidents"
argus_startup_log="$argus_incident_dir/startup-${role}.jsonl"
argus_record() {
  (
    mkdir -p "$argus_incident_dir" || exit 0
    if [ -f "$argus_startup_log" ] && [ "$(wc -c < "$argus_startup_log")" -ge 65536 ]; then
      mv -f "$argus_startup_log" "$argus_startup_log.previous" || exit 0
    fi
    printf '{"ts":%s000,"session":"wrapper-%s","operation":"%s","detail":{"pid":%s,"category":"%s","code":%s,"timestampResolutionMs":1000}}\\n' "$(date +%s)" "$$" "$1" "$$" "$2" "\${3:-0}" >> "$argus_startup_log"
  ) 2>/dev/null
}
argus_stderr() {
  while IFS= read -r argus_line || [ -n "$argus_line" ]; do
    case "$argus_line" in
      *"No SW"*) argus_category='No SW' ;;
      *"Cannot find module"*) argus_category='host module missing' ;;
      *"No such file or directory"*) argus_category='host executable missing' ;;
      *"SyntaxError"*) argus_category='SyntaxError' ;;
      *) argus_category='unclassified' ;;
    esac
    argus_record stderr.observed "$argus_category"
    printf '%s\\n' "$argus_line" >&2
  done
  argus_record stderr.closed unclassified
}
argus_record wrapper.start unclassified
# A killed wrapper may leave a zero-byte FIFO; remove only dead wrappers' own pipes.
for argus_old_fifo in "$argus_incident_dir"/stderr-*.pipe; do
  [ -p "$argus_old_fifo" ] || continue
  argus_old_pid="\${argus_old_fifo##*/stderr-}"
  argus_old_pid="\${argus_old_pid%.pipe}"
  case "$argus_old_pid" in *[!0-9]*|'') continue ;; esac
  kill -0 "$argus_old_pid" 2>/dev/null || rm -f "$argus_old_fifo"
done
argus_fifo="$argus_incident_dir/stderr-$$.pipe"
# Preserve the protocol stream explicitly: background jobs otherwise inherit /dev/null stdin.
exec 3<&0
if ! mkfifo "$argus_fifo" 2>/dev/null; then
  exec ${command}
fi
argus_stderr < "$argus_fifo" 3<&- >/dev/null &
argus_logger_pid=$!
${command} <&3 3<&- 2> "$argus_fifo" &
argus_host_pid=$!
trap 'kill -TERM "$argus_host_pid" 2>/dev/null' TERM INT HUP
wait "$argus_host_pid"
argus_exit=$?
# A signal can interrupt wait before the child has completed its own shutdown.
if kill -0 "$argus_host_pid" 2>/dev/null; then
  wait "$argus_host_pid"
  argus_exit=$?
fi
wait "$argus_logger_pid"
rm -f "$argus_fifo"
argus_record wrapper.exit unclassified "$argus_exit"
exit "$argus_exit"
`
}
