#!/usr/bin/env bash
# Copies the parts of Google's Ink Stroke Modeler and of Abseil that the
# modeler needs into crates/ink-stroke-modeler/third_party, from pinned
# commits. Run it again to update; change the commits below to move on.
set -euo pipefail
cd "$(dirname "$0")/.."
ISM_COMMIT=f2388813b0b25bc3e33d143d369a8367ab2e30c8
ABSL_COMMIT=bc257a88f7c1939f24e0379f14a3589e926c950c # 20250512.0, the version the modeler builds with
DEST=crates/ink-stroke-modeler/third_party
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q https://github.com/google/ink-stroke-modeler.git "$TMP/ism"
git -C "$TMP/ism" checkout -q "$ISM_COMMIT"
git clone -q https://github.com/abseil/abseil-cpp.git "$TMP/absl"
git -C "$TMP/absl" checkout -q "$ABSL_COMMIT"
rm -rf "$DEST/ink-stroke-modeler" "$DEST/abseil-cpp"
mkdir -p "$DEST/ink-stroke-modeler" "$DEST/abseil-cpp"
cp "$TMP/ism/LICENSE" "$DEST/ink-stroke-modeler/"
# The library itself, without its tests.
(cd "$TMP/ism" && find ink_stroke_modeler \( -name '*.cc' -o -name '*.h' \) ! -name '*test*' ! -name 'type_matchers.*' -print0 | xargs -0 cp --parents -t "$OLDPWD/$DEST/ink-stroke-modeler")
cp "$TMP/absl/LICENSE" "$DEST/abseil-cpp/"
# Only the Abseil sources the modeler links, and the headers they include
# (found with `clang++ -MM` for both WebAssembly and the build machine).
(cd "$TMP/absl" && xargs cp --parents -t "$OLDPWD/$DEST/abseil-cpp") <<'LIST'
absl/base/internal/cycleclock.cc
absl/base/internal/raw_logging.cc
absl/base/internal/spinlock.cc
absl/base/internal/spinlock_wait.cc
absl/base/internal/strerror.cc
absl/crc/crc32c.cc
absl/crc/internal/crc.cc
absl/crc/internal/crc_cord_state.cc
absl/crc/internal/crc_memcpy_fallback.cc
absl/crc/internal/crc_x86_arm_combined.cc
absl/debugging/leak_check.cc
absl/debugging/stacktrace.cc
absl/numeric/int128.cc
absl/status/internal/status_internal.cc
absl/status/status.cc
absl/status/status_payload_printer.cc
absl/status/statusor.cc
absl/strings/ascii.cc
absl/strings/charconv.cc
absl/strings/cord.cc
absl/strings/escaping.cc
absl/strings/internal/charconv_bigint.cc
absl/strings/internal/charconv_parse.cc
absl/strings/internal/cord_internal.cc
absl/strings/internal/cord_rep_btree.cc
absl/strings/internal/cord_rep_btree_navigator.cc
absl/strings/internal/cord_rep_btree_reader.cc
absl/strings/internal/cord_rep_consume.cc
absl/strings/internal/cord_rep_crc.cc
absl/strings/internal/cordz_handle.cc
absl/strings/internal/cordz_info.cc
absl/strings/internal/memutil.cc
absl/strings/internal/str_format/arg.cc
absl/strings/internal/str_format/bind.cc
absl/strings/internal/str_format/extension.cc
absl/strings/internal/str_format/float_conversion.cc
absl/strings/internal/str_format/output.cc
absl/strings/internal/str_format/parser.cc
absl/strings/internal/stringify_sink.cc
absl/strings/internal/utf8.cc
absl/strings/match.cc
absl/strings/numbers.cc
absl/strings/str_cat.cc
absl/strings/substitute.cc
absl/time/clock.cc
absl/time/duration.cc
absl/algorithm/algorithm.h
absl/base/attributes.h
absl/base/call_once.h
absl/base/casts.h
absl/base/config.h
absl/base/const_init.h
absl/base/dynamic_annotations.h
absl/base/internal/atomic_hook.h
absl/base/internal/cycleclock.h
absl/base/internal/cycleclock_config.h
absl/base/internal/dynamic_annotations.h
absl/base/internal/endian.h
absl/base/internal/errno_saver.h
absl/base/internal/identity.h
absl/base/internal/iterator_traits.h
absl/base/internal/low_level_alloc.h
absl/base/internal/low_level_scheduling.h
absl/base/internal/nullability_deprecated.h
absl/base/internal/per_thread_tls.h
absl/base/internal/raw_logging.h
absl/base/internal/scheduling_mode.h
absl/base/internal/spinlock.h
absl/base/internal/spinlock_linux.inc
absl/base/internal/spinlock_posix.inc
absl/base/internal/spinlock_wait.h
absl/base/internal/strerror.h
absl/base/internal/sysinfo.h
absl/base/internal/thread_identity.h
absl/base/internal/throw_delegate.h
absl/base/internal/tsan_mutex_interface.h
absl/base/internal/unaligned_access.h
absl/base/internal/unscaledcycleclock.h
absl/base/internal/unscaledcycleclock_config.h
absl/base/log_severity.h
absl/base/macros.h
absl/base/no_destructor.h
absl/base/nullability.h
absl/base/optimization.h
absl/base/options.h
absl/base/policy_checks.h
absl/base/port.h
absl/base/prefetch.h
absl/base/thread_annotations.h
absl/container/fixed_array.h
absl/container/inlined_vector.h
absl/container/internal/compressed_tuple.h
absl/container/internal/container_memory.h
absl/container/internal/inlined_vector.h
absl/crc/crc32c.h
absl/crc/internal/cpu_detect.h
absl/crc/internal/crc.h
absl/crc/internal/crc32_x86_arm_combined_simd.h
absl/crc/internal/crc32c.h
absl/crc/internal/crc32c_inline.h
absl/crc/internal/crc_cord_state.h
absl/crc/internal/crc_internal.h
absl/crc/internal/crc_memcpy.h
absl/debugging/internal/address_is_readable.h
absl/debugging/internal/addresses.h
absl/debugging/internal/elf_mem_image.h
absl/debugging/internal/stacktrace_config.h
absl/debugging/internal/stacktrace_unimplemented-inl.inc
absl/debugging/internal/stacktrace_x86-inl.inc
absl/debugging/internal/symbolize.h
absl/debugging/internal/vdso_support.h
absl/debugging/leak_check.h
absl/debugging/stacktrace.h
absl/debugging/symbolize.h
absl/functional/any_invocable.h
absl/functional/function_ref.h
absl/functional/internal/any_invocable.h
absl/functional/internal/function_ref.h
absl/hash/internal/weakly_mixed_integer.h
absl/memory/memory.h
absl/meta/type_traits.h
absl/numeric/bits.h
absl/numeric/int128.h
absl/numeric/int128_have_intrinsic.inc
absl/numeric/internal/bits.h
absl/numeric/internal/representation.h
absl/status/internal/status_internal.h
absl/status/internal/statusor_internal.h
absl/status/status.h
absl/status/status_payload_printer.h
absl/status/statusor.h
absl/strings/ascii.h
absl/strings/charconv.h
absl/strings/charset.h
absl/strings/cord.h
absl/strings/cord_analysis.h
absl/strings/cord_buffer.h
absl/strings/escaping.h
absl/strings/has_absl_stringify.h
absl/strings/has_ostream_operator.h
absl/strings/internal/charconv_bigint.h
absl/strings/internal/charconv_parse.h
absl/strings/internal/cord_data_edge.h
absl/strings/internal/cord_internal.h
absl/strings/internal/cord_rep_btree.h
absl/strings/internal/cord_rep_btree_navigator.h
absl/strings/internal/cord_rep_btree_reader.h
absl/strings/internal/cord_rep_consume.h
absl/strings/internal/cord_rep_crc.h
absl/strings/internal/cord_rep_flat.h
absl/strings/internal/cordz_functions.h
absl/strings/internal/cordz_handle.h
absl/strings/internal/cordz_info.h
absl/strings/internal/cordz_statistics.h
absl/strings/internal/cordz_update_scope.h
absl/strings/internal/cordz_update_tracker.h
absl/strings/internal/escaping.h
absl/strings/internal/memutil.h
absl/strings/internal/ostringstream.h
absl/strings/internal/resize_uninitialized.h
absl/strings/internal/str_format/arg.h
absl/strings/internal/str_format/bind.h
absl/strings/internal/str_format/checker.h
absl/strings/internal/str_format/constexpr_parser.h
absl/strings/internal/str_format/extension.h
absl/strings/internal/str_format/float_conversion.h
absl/strings/internal/str_format/output.h
absl/strings/internal/str_format/parser.h
absl/strings/internal/str_join_internal.h
absl/strings/internal/str_split_internal.h
absl/strings/internal/string_constant.h
absl/strings/internal/stringify_sink.h
absl/strings/internal/utf8.h
absl/strings/match.h
absl/strings/numbers.h
absl/strings/str_cat.h
absl/strings/str_format.h
absl/strings/str_join.h
absl/strings/str_split.h
absl/strings/string_view.h
absl/strings/strip.h
absl/strings/substitute.h
absl/synchronization/internal/create_thread_identity.h
absl/synchronization/internal/kernel_timeout.h
absl/synchronization/internal/per_thread_sem.h
absl/synchronization/mutex.h
absl/time/civil_time.h
absl/time/clock.h
absl/time/internal/cctz/include/cctz/civil_time.h
absl/time/internal/cctz/include/cctz/civil_time_detail.h
absl/time/internal/cctz/include/cctz/time_zone.h
absl/time/internal/get_current_time_posix.inc
absl/time/time.h
absl/types/compare.h
absl/types/internal/span.h
absl/types/optional.h
absl/types/span.h
absl/types/variant.h
absl/utility/utility.h
LIST
cat > "$DEST/README.md" <<README
# Third-party C++

Copied by \`scripts/vendor-ink-stroke-modeler.sh\`; do not edit by hand.

- \`ink-stroke-modeler/\`: https://github.com/google/ink-stroke-modeler at
  $ISM_COMMIT, Apache-2.0 (\`ink-stroke-modeler/LICENSE\`). Tests left out.
- \`abseil-cpp/\`: https://github.com/abseil/abseil-cpp at $ABSL_COMMIT
  (20250512.0), Apache-2.0 (\`abseil-cpp/LICENSE\`). Only the files the
  modeler uses.
README
echo "Vendored into $DEST"
