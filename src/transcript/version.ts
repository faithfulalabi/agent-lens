/**
 * The projection cache key: a row stamped with an older value was produced by a
 * different projector and must be reprojected rather than trusted. Bump it for
 * any change to this tree that changes what projection emits.
 *
 * This constant lives INSIDE the hashed tree on purpose. `projector-version.test.ts`
 * commits a sha256 over `src/transcript/` + `src/project/`, so one branch cannot bump
 * the version without rehashing. Two branches can still claim the same number for
 * different projectors; that test's pin only makes the collision show in the conflict.
 */
export const PROJECTOR_VERSION = 23;
