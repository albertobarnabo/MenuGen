"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { IconButton } from "@/components/shared/icon-button";

type ThemeName = "light" | "dark" | "system";

const ORDER: ThemeName[] = ["light", "dark", "system"];
const LABEL: Record<ThemeName, string> = {
  light: "Theme: light. Switch to dark",
  dark: "Theme: dark. Switch to system",
  system: "Theme: system. Switch to light",
};

const subscribeNoop = (): (() => void) => () => {};
const getClientSnapshot = (): boolean => true;
const getServerSnapshot = (): boolean => false;

function isThemeName(value: string | undefined): value is ThemeName {
  return value === "light" || value === "dark" || value === "system";
}

/** Icon button cycling light → dark → system. Renders a neutral icon until mounted to avoid hydration mismatches. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeNoop, getClientSnapshot, getServerSnapshot);

  const current: ThemeName = mounted && isThemeName(theme) ? theme : "system";
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const Icon = current === "light" ? SunIcon : current === "dark" ? MoonIcon : MonitorIcon;

  return (
    <IconButton label={mounted ? LABEL[current] : "Toggle theme"} onClick={() => setTheme(next)} side="bottom">
      <Icon />
    </IconButton>
  );
}
