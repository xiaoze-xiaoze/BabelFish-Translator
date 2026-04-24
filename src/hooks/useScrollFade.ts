import { useEffect, useRef, useState } from "react";

function readFadeFlags(el: HTMLDivElement | null) {
  if (!el || el.scrollHeight <= el.clientHeight + 1) {
    return { top: false, bottom: false };
  }
  return {
    top: el.scrollTop > 1,
    bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
  };
}

export function useScrollFade(deps: unknown[]) {
  const listRef = useRef<HTMLDivElement>(null);
  const [hasTopFade, setHasTopFade] = useState(false);
  const [hasBottomFade, setHasBottomFade] = useState(false);

  const syncFade = () => {
    const flags = readFadeFlags(listRef.current);
    setHasTopFade(flags.top);
    setHasBottomFade(flags.bottom);
  };

  useEffect(() => {
    const raf = requestAnimationFrame(syncFade);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    window.addEventListener("resize", syncFade);
    return () => window.removeEventListener("resize", syncFade);
  }, []);

  return { listRef, hasTopFade, hasBottomFade, syncFade };
}
