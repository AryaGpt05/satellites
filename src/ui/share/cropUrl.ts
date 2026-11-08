import type { Share } from '@/lib/backend'

/**
 * Crop URL for a shared pass's image, so recipients see the shared picture immediately.
 * Contract stub (integrator); the share package implements it.
 */
export function shareCropUrl(_share: Share, _px: number): string | undefined {
  return undefined
}
