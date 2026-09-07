/**
 * SARIF 2.1.0 output generator for eslint-plugin-ai-guard.
 *
 * SARIF (Static Analysis Results Interchange Format) is the standard format
 * for GitHub Code Scanning, Azure DevOps, and other CI platforms. By outputting
 * SARIF, ai-guard findings appear as PR annotations in GitHub.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 *
 * === SARIF SCHEMA COMPLIANCE ===
 * GitHub Code Scanning validates SARIF against the 2.1.0 schema.
 * Key requirements enforced here:
 *  - properties.tags: uniqueItems=true (duplicates cause upload rejection)
 *  - region.startLine: minimum=1 (0 causes schema error)
 *  - level: must be "error"|"warning"|"note" |"none"
 *   - kind: must be "fail"| "open"|"informational" (or omitted)
 *  - All string properties: must be non-empty strings, not undefined/null
 *
 * === GITHUB CODE SCANNING PATH RESOLUTION ===
 * GitHub resolves artifact URIs using simple repository-relative POSIX paths.
 * DO NOT emit uriBaseId (%SRCROOT% or any custom base ID) â€” GitHub cannot
 * resolve custom base mappings and will silently suppress all findings.
 * Emit ONLY clean relative paths: "src/server/api.ts", never absolute paths,
 * never Windows backslash paths, never drive letters, never leading "./".
 *
 * === GITHUB CODE SCANNING PERSISTENCE ===
 * For findings to persist as repository-level alerts (not transient PR snapshots),
 * GitHub requires three stable identity anchors in every upload:
 *
 *  1. automationDetails.id  â€” stable tool identifier; groups scan runs together
 *                             MUST be constant across all runs ("ai-guard")
 *  2. partialFingerprints   â€”]\›Z[š\İXÈ\‹\™\İ[\ÚÈ[˜X›\ÈY\XØ][Û‚ˆ
ˆXÜ›ÜÜÈ™\[œËœ˜[˜Ú\]\Ë[™ˆŞ[˜Ú›Ûš^˜][Û‚ˆ
ˆËˆØ]YÛÜH
\ØYİ\
H8 %Ù][ˆHÚ]XˆXİ[ÛœÈÛÜšÙ›İÎÈ[šÜÈ\Âˆ
ˆÛÛÈH\œÚ\İ[[˜[\Ú\ÈÛİ[ˆÛÙHØØ[›š[™Âˆ
‚ˆ
ˆÚ]İ]\ÙKÚ]XˆÛ\ÜÚYšY\È]™\H\ØY\È[ˆ\ÛÛ]YÛ˜\ÚİÛÜÙ\Âˆ
ˆÛ[\È[[YYX][K[™™]™\ˆ›Û[İ\Èš[™[™ÜÈÈH™\ÜÚ]ÜK[]™[ˆ
ˆ[\˜XÚÙ\‹‚ˆ
‹Â‚š[\ÜÈÜ™X]R\ÚHœ›ÛH	ØÜ\ÉÎÂš[\Ü]œ›ÛH	Ü]	ÎÂš[\Ü\HÈ[”™\İ[\ÜİYQ]Z[š[T™\İ[Hœ›ÛH	Ë‹Ù\Û[\[›™\‹šœÉÎÂš[\ÜÈTÔÕQWĞÓÓ‘’QSÑKHTÔÕQWĞĞUQÓÔ–KTÔÕQWĞTÖS×Ô’TÒ×ÕTKTÔÕQWÔ‘SQQPUSÓˆHœ›ÛH	Ë‹Ù\Û[\[›™\‹šœÉÎÂš[\ÜÈÑ×Õ‘T”ÒSÓˆHœ›ÛH	Ë‹İ™\œÚ[Û‹šœÉÎÂ‚‹ËÈ8¥ 8¥ 8¥ ĞT’Qˆ\HYš[š][ÛœÈ8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ 8¥ ‚