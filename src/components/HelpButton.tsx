"use client";

import { usePathname } from "next/navigation";
import { useHelp } from "./HelpProvider";
import { Button } from "./ui/button";
import { HelpCircle } from "lucide-react";

/**
 * Header help button — opens the help panel to the doc matching the current route.
 */
export function HelpButton() {
  const pathname = usePathname();
  const { openHelpForRoute } = useHelp();

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0"
      onClick={() => openHelpForRoute(pathname)}
      title="Help (?)"
    >
      <HelpCircle className="h-4 w-4" />
    </Button>
  );
}
