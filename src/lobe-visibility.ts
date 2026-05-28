import type { LobeName } from "./types.ts";

export type LobeVisibility = Record<LobeName, boolean>;

export const LOBES: LobeName[] = ["frontal", "parietal", "temporal", "occipital", "cerebellum", "stem"];

export function allLobesEnabled(): LobeVisibility {
  return {
    frontal: true,
    parietal: true,
    temporal: true,
    occipital: true,
    cerebellum: true,
    stem: true
  };
}

export function normalizeLobeVisibility(input: Partial<LobeVisibility> | null | undefined): LobeVisibility {
  return {
    ...allLobesEnabled(),
    ...(input ?? {})
  };
}

export function setLobeEnabled(visibility: LobeVisibility, lobe: LobeName, enabled: boolean): LobeVisibility {
  return {
    ...normalizeLobeVisibility(visibility),
    [lobe]: enabled
  };
}

export function setAllLobes(enabled: boolean): LobeVisibility {
  return Object.fromEntries(LOBES.map((lobe) => [lobe, enabled])) as LobeVisibility;
}

export function lobeVisibilityMultiplier(
  lobe: LobeName | undefined,
  visibility: LobeVisibility,
  highlightLobe: LobeName | null
): number {
  const visible = lobe ? normalizeLobeVisibility(visibility)[lobe] : true;
  if (!visible) return 0.08;
  if (!highlightLobe) return 1;
  return lobe === highlightLobe ? 1 : 0.16;
}
