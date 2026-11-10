interface NotFoundPageProps {
  onNavigate: (to: string) => void;
}

export default function NotFoundPage({ onNavigate }: NotFoundPageProps) {
  return (
    <section className="page">
      <h1>Page not found</h1>
      <a
        className="back"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          onNavigate('/');
        }}
      >
        ← All teams
      </a>
    </section>
  );
}
