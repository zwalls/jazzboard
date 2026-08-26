type JazzboardMarkProps = {
  className?: string;
};

export function JazzboardMark({ className }: JazzboardMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 44 44"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#5965E8" height="42" rx="13" width="42" x="1" y="1" />
      <path
        d="M11 29.5C13.7 19.2 18.4 14 28.8 13.2"
        stroke="white"
        strokeLinecap="round"
        strokeWidth="3.2"
      />
      <path
        d="M12.2 32C17.2 26.4 22.5 27.6 31.2 20.2"
        stroke="#B9F5DE"
        strokeLinecap="round"
        strokeWidth="3.2"
      />
      <circle cx="11.5" cy="29.6" fill="white" r="3.1" />
      <circle cx="29.2" cy="13.1" fill="white" r="3.1" />
      <circle cx="31.3" cy="20.2" fill="#B9F5DE" r="3.1" />
    </svg>
  );
}

export function JazzboardLogo() {
  return (
    <span className="jazzboard-logo">
      <JazzboardMark className="jazzboard-logo__mark" />
      <span className="jazzboard-logo__wordmark">Jazzboard</span>
    </span>
  );
}
