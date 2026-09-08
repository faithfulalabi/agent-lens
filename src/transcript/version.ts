/**
 * The projection cache key: a row stamped with an older value was produced by a
 * different projector and must be reprojected rather than trusted. Bump it for
 * any change to this tree that changes what projection emits.
 *
 * This constant lives INSIDE the hashed tree on purpose. `projector-version.test.ts`
 * commits a sha256 over `src/transcript/` + `src/project/`, so bumping the version
 * mechanically changes the hash — the two edits cannot be made independently in the
 * bump-but-forget-to-rehash direction.
 */
export const PROJECTOR_VERSION = 6;
