"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Overview"],
  ["/targets", "Boards"],
  ["/jobs", "Jobs"],
  ["/applications", "Applications"],
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} className={pathname === href ? "active" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
