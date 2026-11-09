export default function Placeholder({ title }: { title: string }) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <div className="card pad">
        <span className="chip warn">В процес на разработка</span>
        <p className="muted" style={{ marginBottom: 0 }}>
          Този раздел още се разработва.
        </p>
      </div>
    </>
  )
}
