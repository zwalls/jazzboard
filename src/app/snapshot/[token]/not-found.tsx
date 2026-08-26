import Link from "next/link";

import { JazzboardLogo } from "@/components/brand/JazzboardLogo";

import styles from "@/components/snapshot/snapshot.module.css";

export default function SnapshotNotFound() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link aria-label="Jazzboard home" className={styles.brand} href="/">
          <JazzboardLogo />
        </Link>
      </header>
      <section className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>Snapshot unavailable</p>
          <h1>This private snapshot can’t be opened.</h1>
          <p className={styles.description}>
            The exact link may be invalid, expired, or revoked. Jazzboard intentionally gives the same response in every case.
          </p>
        </div>
      </section>
    </main>
  );
}
