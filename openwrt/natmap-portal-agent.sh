#!/bin/bash

. /lib/functions.sh
. /usr/share/libubox/jshn.sh

CONFIG_FILE=${NATMAP_PORTAL_AGENT_CONFIG:-/etc/natmap/natmap-portal-agent.conf}
[ -r "$CONFIG_FILE" ] && . "$CONFIG_FILE"

QUEUE_NAME=${NATMAP_REFRESH_QUEUE_NAME:-_natmap-refresh.example.com}
REFRESH_INTERVAL=${NATMAP_REFRESH_INTERVAL:-30}
HEALTH_INTERVAL=${NATMAP_HEALTH_INTERVAL:-300}
FAIL_THRESHOLD=${NATMAP_HEALTH_FAIL_THRESHOLD:-2}
TIMEOUT=${NATMAP_HEALTH_TIMEOUT:-4}
MAX_AGE_MS=${NATMAP_REFRESH_MAX_AGE_MS:-900000}
REFRESH_RETRY_LIMIT=${NATMAP_REFRESH_RETRY_LIMIT:-3}
REFRESH_RESTART_WAIT_SECONDS=${NATMAP_REFRESH_RESTART_WAIT_SECONDS:-10}
CLEANUP_DISABLED=${NATMAP_CLEANUP_DISABLED:-1}
CLEANUP_INTERVAL=${NATMAP_CLEANUP_INTERVAL:-300}
DNS_RECONCILE_INTERVAL=${NATMAP_DNS_RECONCILE_INTERVAL:-300}
STATE_DIR=/tmp/natmap-portal-agent
STATUS_PATH=/var/run/natmap
CUSTOM_DIR=/etc/natmap/health.d
LOCK_FILE=/var/lock/natmap-portal-agent.lock
LOG_TAG=natmap-portal

mkdir -p "$STATE_DIR" /var/lock

log() {
	logger -t "$LOG_TAG" "$*"
	[ "${NATMAP_PORTAL_VERBOSE:-0}" = 1 ] && echo "$*"
}

safe_name() {
	printf %s "$1" | tr -c A-Za-z0-9_.- _
}

atomic_write_file() {
	local file="$1" content="$2" tmp="${1}.$$"
	printf '%s\n' "$content" > "$tmp" && mv "$tmp" "$file"
}

status_file_for_sid() {
	local sid="$1" f
	for f in "$STATUS_PATH"/*.json; do
		[ -e "$f" ] || return 1
		[ "$(jsonfilter -q -i "$f" -e @.sid 2>/dev/null)" = "$sid" ] || continue
		echo "$f"
		return 0
	done
	return 1
}

find_section_by_domain() {
	local wanted="$1" found=""
	config_load natmap
	find_cb() {
		local section="$1" srv enable
		[ -n "$found" ] && return 0
		config_get_bool enable "$section" enable 0
		[ "$enable" = 1 ] || return 0
		config_get srv "$section" ddns_srv
		[ "$srv" = "$wanted" ] && found="$section"
	}
	config_foreach find_cb natmap
	[ -n "$found" ] || return 1
	SECTION="$found"
}

public_port_for_section() {
	local section="$1" status_file
	status_file="$(status_file_for_sid "$section")" || return 1
	jsonfilter -q -i "$status_file" -e @.port 2>/dev/null
}

wait_public_port() {
	local section="$1" i port
	i=0
	while [ "$i" -lt "$REFRESH_RESTART_WAIT_SECONDS" ]; do
		port="$(public_port_for_section "$section" 2>/dev/null)"
		if [ -n "$port" ]; then
			WAIT_PUBLIC_PORT="$port"
			return 0
		fi
		i=$((i + 1))
		sleep 1
	done
	return 1
}

restart_section_once() {
	local section="$1" reason="$2" port
	port="$(uci -q get "natmap.${section}.port")"
	if echo "$port" | grep -q -- -; then
		uci -q set "natmap.${section}.port_pointer=1"
		uci -q commit natmap
	fi
	log "$section: restarting section only ($reason)"
	/etc/init.d/natmap stop "$section" >/dev/null 2>&1
	sleep 2
	/etc/init.d/natmap start "$section" >/dev/null 2>&1
}

restart_section() {
	local section="$1" reason="$2" ensure_changed="${3:-0}" before after attempt limit label
	before="$(public_port_for_section "$section" 2>/dev/null || true)"
	limit=1
	[ "$ensure_changed" = 1 ] && limit="$REFRESH_RETRY_LIMIT"
	attempt=1
	while [ "$attempt" -le "$limit" ]; do
		label="$reason"
		[ "$ensure_changed" = 1 ] && label="$reason attempt $attempt/$limit"
		restart_section_once "$section" "$label"
		if [ "$ensure_changed" != 1 ]; then
			return 0
		fi
		WAIT_PUBLIC_PORT=""
		if wait_public_port "$section"; then
			after="$WAIT_PUBLIC_PORT"
			if [ -z "$before" ] || [ "$after" != "$before" ]; then
				log "$section: public port changed ${before:-unknown} -> $after"
				return 0
			fi
			log "$section: public port still $after after manual refresh"
		else
			log "$section: no runtime public port after manual refresh attempt $attempt"
		fi
		attempt=$((attempt + 1))
	done
	return 0
}

fetch_refresh_request() {
	local output line content old_ifs domain ts nonce best_domain best_ts best_nonce
	output="$(nslookup -type=TXT "$QUEUE_NAME" 2>/dev/null)" || return 1
	while IFS= read -r line; do
		case "$line" in
			*"text = "*) content="${line#*text = }" ;;
			*) continue ;;
		esac
		content="$(printf '%s' "$content" | sed 's/^"//;s/"$//;s/"[[:space:]]*"//g')"
		old_ifs="$IFS"; IFS="|"; set -- $content; IFS="$old_ifs"
		domain="$1"; ts="$2"; nonce="$3"
		[ -n "$domain" ] && [ -n "$ts" ] && [ -n "$nonce" ] || continue
		case "$ts" in *[!0-9]*|"") continue;; esac
		if [ -z "$best_ts" ] || [ "$ts" -gt "$best_ts" ]; then
			best_domain="$domain"; best_ts="$ts"; best_nonce="$nonce"
		fi
	done <<EOF
$output
EOF
	[ -n "$best_nonce" ] || return 1
	REQUEST_CONTENT="$best_domain|$best_ts|$best_nonce"
}

process_refresh_once() {
	fetch_refresh_request || return 0
	local old_ifs domain ts nonce last now_ms age
	old_ifs="$IFS"; IFS="|"; set -- $REQUEST_CONTENT; IFS="$old_ifs"
	domain="$1"; ts="$2"; nonce="$3"
	[ -n "$domain" ] && [ -n "$ts" ] && [ -n "$nonce" ] || return 0
	last="$(cat "$STATE_DIR/refresh.last" 2>/dev/null)"
	[ "$nonce" = "$last" ] && return 0
	case "$ts" in *[!0-9]*|"") echo "$nonce" > "$STATE_DIR/refresh.last"; return 0;; esac
	now_ms=$(($(date +%s) * 1000))
	age=$((now_ms - ts))
	if [ "$age" -gt "$MAX_AGE_MS" ]; then
		echo "$nonce" > "$STATE_DIR/refresh.last"
		log "$domain: ignored stale refresh request"
		return 0
	fi
	if find_section_by_domain "$domain"; then
		restart_section "$SECTION" "manual refresh for $domain" 1
	else
		log "$domain: no natmap section matched"
	fi
	echo "$nonce" > "$STATE_DIR/refresh.last"
}

run_custom_probe() {
	local probe probe_name
	probe_name="$(safe_name "${ddns_srv:-$sid}")"
	probe="$CUSTOM_DIR/$probe_name"
	[ -x "$probe" ] || return 2
	NATMAP_SID="$sid" NATMAP_COMMENT="$comment" NATMAP_DDNS_SRV="$ddns_srv" NATMAP_DDNS_SRV_TARGET="$ddns_srv_target" NATMAP_DDNS_HTTPS_TARGET="$ddns_https_target" NATMAP_VLESS_FALLBACK_TARGET="$(vless_fallback_target)" NATMAP_SERVICE="$ddns_srv_serv" NATMAP_PROTO="$status_proto" NATMAP_PUBLIC_IP="$public_ip" NATMAP_PUBLIC_PORT="$public_port" NATMAP_INNER_IP="$inner_ip" NATMAP_INNER_PORT="$inner_port" NATMAP_FORWARD_TARGET="$forward_target" NATMAP_FORWARD_PORT="$forward_port" NATMAP_TIMEOUT="$TIMEOUT" "$probe"
}

tcp_connect_probe() {
	timeout "$TIMEOUT" nc "$public_ip" "$public_port" </dev/null >/dev/null 2>&1
}

http_probe_host() {
	local scheme="$1" host="$2" code
	[ -n "$host" ] && [ "$host" != "." ] || return 1
	code="$(curl -k -sS -o /dev/null -w '%{http_code}' --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" --resolve "${host}:${public_port}:${public_ip}" "${scheme}://${host}:${public_port}/" 2>/dev/null)" || return 1
	case "$code" in
		[1-5][0-9][0-9]) return 0;;
	esac
	return 1
}

http_probe() {
	local scheme="$1" host
	host="${ddns_https_target:-}"
	[ -n "$host" ] && [ "$host" != "." ] || host="${ddns_srv_target:-}"
	[ -n "$host" ] && [ "$host" != "." ] || host="$ddns_srv"
	http_probe_host "$scheme" "$host"
}

vless_fallback_target() {
	local host target first host_parent parent target_suffix
	host="$(printf %s "${ddns_srv:-}" | tr A-Z a-z)"
	target="${ddns_srv_target:-}"
	[ -n "$host" ] && [ -n "$target" ] && [ "$target" != "." ] || return 1
	case "$host" in *.*.*) ;; *) printf %s "$target"; return 0;; esac
	first="${host%%.*}"
	host_parent="${host#*.}"
	parent="${host_parent#*.}"
	target_suffix="${target#*.}"
	if [ -n "$first" ] && [ "$first" != "$host" ] && [ -n "$parent" ] && [ "$target_suffix" = "$parent" ]; then
		case "$target" in "$first".*) printf %s "$target";; *) printf %s "$first.$target";; esac
		return 0
	fi
	printf %s "$target"
}

vless_fallback_probe() {
	http_probe_host https "$(vless_fallback_target)"
}

rdp_probe() {
	# RDP does not send a plaintext banner. Fall back to a TCP connect check unless a custom probe exists.
	tcp_connect_probe
}

probe_section() {
	run_custom_probe
	local rc=$? service proto
	[ "$rc" = 0 ] && return 0
	[ "$rc" = 1 ] && return 1
	service="$(printf %s "${ddns_srv_serv:-}" | tr A-Z a-z)"
	proto="$(printf %s "${ddns_srv_proto:-$status_proto}" | tr A-Z a-z)"
	case "$status_proto" in
		tcp)
			case "$service:$proto" in
				http:tls|https:*) http_probe https; return $?;;
				http:*|web:*) http_probe http; return $?;;
				vless_fb:*|vless-fb:*) vless_fallback_probe; return $?;;
				ssh:*) tcp_connect_probe; return $?;;
				ftp:*) tcp_connect_probe; return $?;;
				ftps:*) tcp_connect_probe; return $?;;
				rdp:*) rdp_probe; return $?;;
			esac
			tcp_connect_probe; return $?;;
		udp)
			# Generic UDP has no reliable response semantics. Use a custom probe for HY2/QUIC/etc.
			return 0;;
	esac
	return 0
}

failure_file() { echo "$STATE_DIR/$1.fail"; }
record_success() { rm -f "$(failure_file "$1")"; }
record_failure() {
	local section="$1" reason="$2" file count
	file="$(failure_file "$section")"
	count=0; [ -s "$file" ] && count="$(cat "$file" 2>/dev/null || echo 0)"
	case "$count" in *[!0-9]*|"") count=0;; esac
	count=$((count + 1))
	if ! atomic_write_file "$file" "$count"; then
		log "$section ${ddns_srv:-$comment}: failed to persist probe failure counter"
	fi
	log "$section ${ddns_srv:-$comment}: probe failed ($reason), count=$count/$FAIL_THRESHOLD"
	[ "$count" -lt "$FAIL_THRESHOLD" ] && return 0
	restart_section "$section" "health check failed"
	rm -f "$file"
}

dns_srv_record_name() {
	local service proto
	service="${ddns_srv_serv#_}"
	proto="${ddns_srv_proto:-$status_proto}"
	proto="${proto#_}"
	[ -n "$service" ] && [ -n "$proto" ] && [ -n "$ddns_srv" ] || return 1
	printf '_%s._%s.%s' "$service" "$proto" "$ddns_srv"
}

dns_srv_port() {
	local name output line data
	name="$(dns_srv_record_name)" || return 1
	output="$(nslookup -type=SRV "$name" 2>/dev/null)" || return 1
	while IFS= read -r line; do
		case "$line" in
			*"service = "*) data="${line#*service = }" ;;
			*) continue ;;
		esac
		set -- $data
		case "$3" in *[!0-9]*|"") return 1;; *) printf %s "$3"; return 0;; esac
	done <<EOF
$output
EOF
	return 1
}

reconcile_dns_srv() {
	local dns_port ddns_script ddns_tokens ddns_a ddns_aaaa ddns_https ddns_https_svcparams ddns_https_priority family marker sig old now old_ts old_sig payload
	dns_port="$(dns_srv_port)" || return 0
	[ "$dns_port" = "$public_port" ] && return 0

	marker="$STATE_DIR/$(safe_name "$sid").reconcile"
	sig="${ddns_srv}|${ddns_srv_serv}|${ddns_srv_proto:-$status_proto}|${public_ip}|${public_port}|${dns_port}"
	now="$(date +%s)"
	if [ -r "$marker" ]; then
		old="$(cat "$marker" 2>/dev/null)"
		old_ts="${old%%|*}"
		old_sig="${old#*|}"
		case "$old_ts" in *[!0-9]*|"") old_ts=0;; esac
		if [ "$old_sig" = "$sig" ] && [ $((now - old_ts)) -lt "$DNS_RECONCILE_INTERVAL" ]; then
			return 0
		fi
	fi

	config_get ddns_script "$sid" ddns_script
	[ -x "$ddns_script" ] || return 0
	config_get ddns_tokens "$sid" ddns_tokens
	[ -n "$ddns_tokens" ] || return 0
	case "$ddns_tokens" in *"<"*|*">"*) return 0;; esac
	config_get family "$sid" family ipv4
	config_get ddns_a "$sid" ddns_a
	config_get ddns_aaaa "$sid" ddns_aaaa
	config_get ddns_srv_priority "$sid" ddns_srv_priority 0
	config_get ddns_srv_weight "$sid" ddns_srv_weight 65535
	config_get ddns_https "$sid" ddns_https
	config_get ddns_https_target "$sid" ddns_https_target
	config_get ddns_https_svcparams "$sid" ddns_https_svcparams
	config_get ddns_https_priority "$sid" ddns_https_priority 1

	json_init
	json_add_string tokens "$ddns_tokens"
	case "$family" in
		ipv6) [ -n "$ddns_aaaa" ] && json_add_string hostype "AAAA" && json_add_string host "$ddns_aaaa" ;;
		*) [ -n "$ddns_a" ] && json_add_string hostype "A" && json_add_string host "$ddns_a" ;;
	esac
	json_add_string ip "$public_ip"
	json_add_int port "$public_port"
	json_add_string srv "$ddns_srv"
	json_add_string srv_serv "$ddns_srv_serv"
	json_add_string srv_proto "${ddns_srv_proto:-$status_proto}"
	json_add_string srv_target "$ddns_srv_target"
	json_add_int srv_priority "$ddns_srv_priority"
	json_add_int srv_weight "$ddns_srv_weight"
	if [ -n "$ddns_https" ]; then
		json_add_string https "$ddns_https"
		json_add_string https_target "$ddns_https_target"
		json_add_string https_svcparams "$ddns_https_svcparams"
		json_add_int https_priority "$ddns_https_priority"
	fi
	payload="$(json_dump)"
	atomic_write_file "$marker" "$now|$sig" >/dev/null 2>&1 || true
	if "$ddns_script" "$payload"; then
		log "$sid ${ddns_srv}: reconciled SRV port $dns_port -> $public_port"
	else
		log "$sid ${ddns_srv}: failed to reconcile SRV port $dns_port -> $public_port"
	fi
}

check_section() {
	local section="$1" enable forward status_file
	sid="$section"
	config_get_bool enable "$section" enable 0; [ "$enable" = 1 ] || return 0
	config_get_bool forward "$section" forward 0; [ "$forward" = 1 ] || return 0
	config_get ddns_srv "$section" ddns_srv; [ -n "$ddns_srv" ] || return 0
	config_get comment "$section" comment
	config_get ddns_srv_serv "$section" ddns_srv_serv
	config_get ddns_srv_proto "$section" ddns_srv_proto
	config_get ddns_srv_target "$section" ddns_srv_target
	config_get ddns_https_target "$section" ddns_https_target
	config_get port "$section" port
	config_get forward_target "$section" forward_target
	config_get forward_port "$section" forward_port
	status_file="$(status_file_for_sid "$section")" || { record_failure "$section" missing-status; return 0; }
	public_ip="$(jsonfilter -q -i "$status_file" -e @.ip 2>/dev/null)"
	public_port="$(jsonfilter -q -i "$status_file" -e @.port 2>/dev/null)"
	status_proto="$(jsonfilter -q -i "$status_file" -e @.protocol 2>/dev/null)"
	inner_ip="$(jsonfilter -q -i "$status_file" -e @.inner_ip 2>/dev/null)"
	inner_port="$(jsonfilter -q -i "$status_file" -e @.inner_port 2>/dev/null)"
	[ -n "$public_ip" ] && [ -n "$public_port" ] || { record_failure "$section" bad-status; return 0; }
	reconcile_dns_srv
	if probe_section; then record_success "$section"; else record_failure "$section" "${public_ip}:${public_port}/${status_proto}"; fi
}

process_health_once() {
	config_load natmap
	config_foreach check_section natmap
}

cleanup_file() { echo "$STATE_DIR/$(safe_name "$1").cleanup"; }

cleanup_disabled_section() {
	local section="$1" enable ddns_script ddns_tokens ddns_srv ddns_srv_serv ddns_srv_proto ddns_https sig file payload

	[ "$CLEANUP_DISABLED" = 1 ] || return 0
	config_get_bool enable "$section" enable 0
	if [ "$enable" = 1 ]; then
		rm -f "$(cleanup_file "$section")"
		return 0
	fi
	config_get ddns_script "$section" ddns_script
	[ -x "$ddns_script" ] || return 0
	config_get ddns_tokens "$section" ddns_tokens
	[ -n "$ddns_tokens" ] || return 0
	case "$ddns_tokens" in *"<"*|*">"*) return 0;; esac
	config_get ddns_srv "$section" ddns_srv
	config_get ddns_srv_serv "$section" ddns_srv_serv
	config_get ddns_srv_proto "$section" ddns_srv_proto
	config_get ddns_https "$section" ddns_https
	[ -n "$ddns_srv" ] || [ -n "$ddns_https" ] || return 0

	sig="${ddns_srv}|${ddns_srv_serv}|${ddns_srv_proto:-tcp}|${ddns_https}|${ddns_script}"
	file="$(cleanup_file "$section")"
	[ -r "$file" ] && [ "$(cat "$file" 2>/dev/null)" = "$sig" ] && return 0

	json_init
	json_add_boolean cleanup 1
	json_add_string tokens "$ddns_tokens"
	[ -n "$ddns_srv" ] && json_add_string srv "$ddns_srv"
	[ -n "$ddns_srv_serv" ] && json_add_string srv_serv "$ddns_srv_serv"
	json_add_string srv_proto "${ddns_srv_proto:-tcp}"
	[ -n "$ddns_https" ] && json_add_string https "$ddns_https"
	payload="$(json_dump)"
	if "$ddns_script" "$payload"; then
		echo "$sig" > "$file"
		log "$section: cleaned DNS for disabled section ${ddns_srv:-$ddns_https}"
	else
		log "$section: failed to clean DNS for disabled section ${ddns_srv:-$ddns_https}"
	fi
}

process_cleanup_once() {
	config_load natmap
	config_foreach cleanup_disabled_section natmap
}


daemon_loop() {
	log "portal agent started: refresh=${REFRESH_INTERVAL}s health=${HEALTH_INTERVAL}s cleanup=${CLEANUP_INTERVAL}s queue=${QUEUE_NAME}"
	local last_health=0 last_cleanup=0 now
	while true; do
		process_refresh_once
		now=$(date +%s)
		if [ $((now - last_health)) -ge "$HEALTH_INTERVAL" ]; then
			process_health_once
			last_health="$now"
		fi
		if [ "$CLEANUP_DISABLED" = 1 ] && [ $((now - last_cleanup)) -ge "$CLEANUP_INTERVAL" ]; then
			process_cleanup_once
			last_cleanup="$now"
		fi
		sleep "$REFRESH_INTERVAL"
	done
}

run_locked_daemon() {
	(
		flock -n 9 || exit 0
		daemon_loop
	) 9>"$LOCK_FILE"
}

start_daemon() {
	run_locked_daemon &
}

case "$1" in
	--once-refresh) process_refresh_once ;;
	--once-health) process_health_once ;;
	--once-cleanup) process_cleanup_once ;;
	--daemon) run_locked_daemon ;;
	*) start_daemon ;;
esac
