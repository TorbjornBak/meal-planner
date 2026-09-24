"use client";

import { createContext, useContext } from "react";

const TurnstileEnabledContext = createContext(true);

export function TurnstileConfig({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return (
    <TurnstileEnabledContext.Provider value={enabled}>
      {children}
    </TurnstileEnabledContext.Provider>
  );
}

export function useTurnstileEnabled(): boolean {
  return useContext(TurnstileEnabledContext);
}
