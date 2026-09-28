import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "framer-motion";
import type { MotionValue } from "framer-motion";
import "./landing-page.css";

type IconName = "calendar" | "notes" | "spark" | "bill" | "shield" | "arrow" | "plus" | "check" | "message" | "clock" | "chevron";
type ProductType = "notes" | "messages" | "billing";
type LayerTone = "base" | "mid" | "top";

const easeOutSoft: [number, number, number, number] = [0.22, 1, 0.36, 1];

const faqs = [
  [
    "What can Synari handle for my practice?",
    "Synari supports the work around care: scheduling, clinical documentation, client communication, billing workflows, insurance verification, and practice reporting.",
  ],
  [
    "Will Synari replace the tools I already use?",
    "Synari is designed to fit into your existing workflow. During onboarding, we map the systems you use today and help you decide what to connect, keep, or simplify.",
  ],
  [
    "How does AI documentation work?",
    "With your consent and controls, Synari turns session context into structured draft notes. You review and approve every clinical document before it becomes part of the record.",
  ],
  [
    "Is Synari HIPAA compliant?",
    "Yes. Synari is built for healthcare workflows with privacy, encryption, access controls, and HIPAA-conscious operational practices at its foundation.",
  ],
  [
    "How long does setup take?",
    "Most practices can begin with a focused workflow in days. We expand automation gradually so your team stays comfortable and in control.",
  ],
  [
    "What does Synari cost?",
    "Plans are tailored to practice size and the workflows you want to automate. Book a demo and we will recommend the simplest useful starting point.",
  ],
];

const chapters = [
  {
    num: "01",
    label: "Document",
    eyebrow: "Clinical documentation",
    title: "Notes that start themselves",
    copy: "Synari turns session context into a thoughtful draft, ready for your review instead of waiting on your evening.",
    type: "notes" as ProductType,
  },
  {
    num: "02",
    label: "Communicate",
    eyebrow: "Client communication",
    title: "Present, even between sessions",
    copy: "Routine questions, rescheduling, and follow-ups move forward while you stay in control of every sensitive moment.",
    type: "messages" as ProductType,
  },
  {
    num: "03",
    label: "Get paid",
    eyebrow: "Billing workflows",
    title: "Your work gets paid for",
    copy: "From superbills to claim follow-up, Synari keeps the revenue cycle moving without turning you into a billing specialist.",
    type: "billing" as ProductType,
  },
];

const panelRanges: [number, number, number, number][] = [
  [0.03, 0.09, 0.2, 0.26],
  [0.27, 0.33, 0.44, 0.5],
  [0.51, 0.57, 0.66, 0.72],
];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    calendar: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="3" />
        <path d="M8 3v4m8-4v4M4 10h16" />
      </>
    ),
    notes: (
      <>
        <path d="M7 3h8l4 4v14H7z" />
        <path d="M15 3v5h5M10 12h6m-6 4h6" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
        <path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" />
      </>
    ),
    bill: (
      <>
        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
        <path d="M9 8h6m-6 4h6m-6 4h4" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    message: (
      <>
        <path d="M4 5h16v11H9l-5 4z" />
        <path d="M8 9h8m-8 3h5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    chevron: <path d="m7 10 5 5 5-5" />,
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

const layerTones: Record<LayerTone, [string, string]> = {
  top: ["#1cc2b2", "#0d9488"],
  mid: ["#5cd2c5", "#2cb8ab"],
  base: ["#aeeae2", "#7fdcd2"],
};

function LayerDiamond({ tone, className }: { tone: LayerTone; className?: string }) {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [from, to] = layerTones[tone];
  return (
    <svg className={className} viewBox="0 0 232 132" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="40" y1="10" x2="200" y2="130" gradientUnits="userSpaceOnUse">
          <stop stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <path
        d="M116 12 L220 66 L116 120 L12 66 Z"
        fill={`url(#${gradientId})`}
        stroke={`url(#${gradientId})`}
        strokeWidth="18"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StackMark({ className }: { className?: string }) {
  return (
    <span className={["stack-mark", className].filter(Boolean).join(" ")} aria-hidden="true">
      <LayerDiamond tone="base" className="stack-mark-base" />
      <LayerDiamond tone="mid" className="stack-mark-mid" />
      <LayerDiamond tone="top" className="stack-mark-top" />
    </span>
  );
}

function Brand({ withWord = true }: { withWord?: boolean }) {
  return (
    <span className="brand">
      <StackMark className="brand-mark" />
      {withWord && <span className="brand-word">Synari</span>}
    </span>
  );
}

function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 42, filter: "blur(6px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-10% 0px" }}
      transition={{ duration: 0.9, delay, ease: easeOutSoft }}
    >
      {children}
    </motion.div>
  );
}

const navItems = [
  { id: "top", label: "Synari", home: true },
  { id: "layers", label: "Product" },
  { id: "how", label: "How it works" },
  { id: "faq", label: "FAQ" },
  { id: "demo", label: "Demo", demo: true },
  { id: "login", label: "Sign in", login: true, href: "/login" },
];

function Nav({ activeSection, onNavigate }: { activeSection: string; onNavigate: (section: string) => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const highlighted = hovered || activeSection;
  return (
    <nav className="nav" aria-label="Main navigation" onMouseLeave={() => setHovered(null)}>
      {navItems.map((item) => (
        <a
          key={item.id}
          className={[
            "nav-item",
            `nav-${item.id}`,
            item.home ? "nav-home" : "",
            item.demo ? "nav-demo" : "",
            highlighted === item.id ? "is-highlighted" : "",
            activeSection === item.id ? "is-active" : "",
          ].filter(Boolean).join(" ")}
          href={item.href || `#${item.id}`}
          aria-label={item.home ? "Synari home" : undefined}
          aria-current={activeSection === item.id ? "page" : undefined}
          onMouseEnter={() => setHovered(item.id)}
          onFocus={() => setHovered(item.id)}
          onBlur={() => setHovered(null)}
          onClick={() => {
            setHovered(null);
            if (!item.login) onNavigate(item.id);
          }}
        >
          {item.home ? <Brand /> : item.label}
        </a>
      ))}
    </nav>
  );
}

function DemoForm({ dark = false }: { dark?: boolean }) {
  const [email, setEmail] = useState("");
  const inputId = useId();
  const navigate = useNavigate();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email) return;
    navigate("/demo", { state: { email } });
  }
  return (
    <form className={`email-form ${dark ? "email-form-dark" : ""}`} onSubmit={submit}>
      <label className="sr-only" htmlFor={inputId}>Your work email</label>
      <input id={inputId} type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Your work email" />
      <button type="submit">Get a demo <Icon name="arrow" size={16} /></button>
    </form>
  );
}

function Hero() {
  const reduce = useReducedMotion();
  const heroRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const yTop = useTransform(scrollYProgress, [0, 1], [0, -170]);
  const yMid = useTransform(scrollYProgress, [0, 1], [0, -60]);
  const yBase = useTransform(scrollYProgress, [0, 1], [0, 70]);
  const stackFade = useTransform(scrollYProgress, [0, 0.9], [1, 0.25]);
  const tiltX = useSpring(0, { stiffness: 55, damping: 14 });
  const tiltY = useSpring(0, { stiffness: 55, damping: 14 });

  function handlePointer(event: ReactPointerEvent<HTMLElement>) {
    if (reduce || event.pointerType !== "mouse") return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = (event.clientX - (rect.left + rect.width / 2)) / rect.width;
    const py = (event.clientY - (rect.top + rect.height / 2)) / rect.height;
    tiltY.set(px * 9);
    tiltX.set(py * -7);
  }
  function resetPointer() {
    tiltY.set(0);
    tiltX.set(0);
  }

  return (
    <section className="hero" id="top" ref={heroRef} onPointerMove={handlePointer} onPointerLeave={resetPointer}>
      <div className="hero-backdrop" aria-hidden="true">
        <div className="hero-grid" />
        <div className="hero-glow hero-glow-a" />
        <div className="hero-glow hero-glow-b" />
        <div className="hero-ambient"><i /><i /><i /><i /><i /><i /></div>
      </div>
      <div className="hero-inner">
        <div className="hero-copy">
          <p className="eyebrow eyebrow-light"><span className="eyebrow-diamond" />Practice management, in three layers</p>
          <h1>
            <span>You listen.</span>
            <em>We’ll handle the rest.</em>
          </h1>
          <p className="hero-subtitle">
            Synari runs the layers underneath your practice — documentation, communication,
            and billing — so the hour belongs to your client.
          </p>
          <DemoForm dark />
          <p className="hero-hint">Built for therapists · HIPAA-conscious by design</p>
        </div>
        <motion.div
          className="hero-stack"
          ref={stageRef}
          style={reduce ? undefined : { rotateX: tiltX, rotateY: tiltY, transformPerspective: 1100, opacity: stackFade }}
          aria-hidden="true"
        >
          <motion.div className="hs-layer" style={reduce ? undefined : { y: yBase }}>
            <span className="hs-float hs-float-a"><LayerDiamond tone="base" /></span>
          </motion.div>
          <motion.div className="hs-layer" style={reduce ? undefined : { y: yMid }}>
            <span className="hs-float hs-float-b"><LayerDiamond tone="mid" /></span>
          </motion.div>
          <motion.div className="hs-layer" style={reduce ? undefined : { y: yTop }}>
            <span className="hs-float hs-float-c"><LayerDiamond tone="top" /></span>
          </motion.div>
          <span className="hs-tag hs-tag-top">Billing</span>
          <span className="hs-tag hs-tag-mid">Communication</span>
          <span className="hs-tag hs-tag-base">Documentation</span>
        </motion.div>
      </div>
      <a href="#layers" className="scroll-cue" aria-label="Scroll to explore the layers">
        <span>Explore the layers</span>
        <Icon name="chevron" />
      </a>
    </section>
  );
}

function ProductMock({ type }: { type: ProductType }) {
  if (type === "notes") {
    return (
      <div className="product-mock product-notes">
        <div className="mock-top">
          <Brand />
          <span className="status"><i /> Listening</span>
        </div>
        <div className="wave">
          {Array.from({ length: 28 }).map((_, index) => (
            <i key={index} style={{ "--h": `${20 + ((index * 17) % 70)}%`, "--d": `${index * 35}ms` } as CSSProperties} />
          ))}
        </div>
        <div className="mock-copy">
          <span>Session context captured</span>
          <strong>Drafting a SOAP note…</strong>
        </div>
        <div className="progress"><i /></div>
      </div>
    );
  }
  if (type === "messages") {
    return (
      <div className="product-mock product-messages">
        <div className="mock-top">
          <span className="avatar">JM</span>
          <span><strong>Jordan M.</strong><small>Client message</small></span>
          <span className="status"><i /> Reviewed</span>
        </div>
        <div className="bubble incoming">Could we move tomorrow’s appointment to later this week?</div>
        <div className="assistant-line"><Icon name="spark" /> Synari found two openings and drafted a reply.</div>
        <div className="bubble outgoing">Absolutely. Thursday at 3:30 or Friday at 11:00 are available. Which works best?</div>
      </div>
    );
  }
  return (
    <div className="product-mock product-billing">
      <div className="mock-top">
        <Brand />
        <span className="status"><i /> Complete</span>
      </div>
      <div className="billing-total">
        <small>This week</small>
        <strong>$6,840.00</strong>
        <span>18 sessions processed</span>
      </div>
      <div className="billing-list">
        <div><span><i className="payer payer-a" /> Aetna</span><strong>$420.00</strong></div>
        <div><span><i className="payer payer-b" /> Self-pay</span><strong>$180.00</strong></div>
        <div><span><i className="payer payer-c" /> Cigna</span><strong>$360.00</strong></div>
      </div>
    </div>
  );
}

function StoryPanel({
  progress,
  at,
  final = false,
  children,
}: {
  progress: MotionValue<number>;
  at: [number, number, number, number];
  final?: boolean;
  children: ReactNode;
}) {
  const opacity = useTransform(progress, at, final ? [0, 1, 1, 1] : [0, 1, 1, 0]);
  const y = useTransform(progress, at, final ? [64, 0, 0, 0] : [64, 0, 0, -64]);
  return (
    <motion.div className={`story-panel ${final ? "is-final" : ""}`} style={{ opacity, y }}>
      {children}
    </motion.div>
  );
}

function StackStoryStatic() {
  return (
    <section className="layers layers-static" id="layers" aria-label="What Synari handles">
      <div className="layers-static-inner">
        {chapters.map((chapter) => (
          <article key={chapter.num} className="static-chapter">
            <div>
              <p className="eyebrow"><span className="eyebrow-diamond" />Layer {chapter.num} · {chapter.eyebrow}</p>
              <h3>{chapter.title}</h3>
              <p className="story-copy">{chapter.copy}</p>
            </div>
            <ProductMock type={chapter.type} />
          </article>
        ))}
        <div className="static-finale">
          <StackMark className="static-finale-mark" />
          <h3>AI that handles the work around care.</h3>
        </div>
      </div>
    </section>
  );
}

function StackStory() {
  const reduce = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start start", "end end"] });
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 24, mass: 0.5, restDelta: 0.0005 });

  const baseY = useTransform(progress, [0, 0.1, 0.72, 0.84], [-380, 112, 112, 36]);
  const baseOpacity = useTransform(progress, [0, 0.07, 0.24, 0.29, 0.72, 0.8], [0, 1, 1, 0.45, 0.45, 1]);
  const baseScale = useTransform(progress, [0, 0.1], [1.14, 1]);
  const midY = useTransform(progress, [0.26, 0.36], [-380, 0]);
  const midOpacity = useTransform(progress, [0.26, 0.33, 0.48, 0.53, 0.72, 0.8], [0, 1, 1, 0.45, 0.45, 1]);
  const midScale = useTransform(progress, [0.26, 0.36], [1.14, 1]);
  const topY = useTransform(progress, [0.5, 0.6, 0.72, 0.84], [-380, -112, -112, -36]);
  const topOpacity = useTransform(progress, [0.5, 0.57], [0, 1]);
  const topScale = useTransform(progress, [0.5, 0.6], [1.14, 1]);
  const glowOpacity = useTransform(progress, [0.76, 0.9], [0, 1]);
  const stackY = useTransform(progress, [0.72, 0.86], [0, -34]);
  const wordOpacity = useTransform(progress, [0.8, 0.9], [0, 1]);
  const wordY = useTransform(progress, [0.8, 0.92], [26, 0]);
  const railFill = useTransform(progress, [0.03, 0.72], [0, 1]);

  const [chapter, setChapter] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (value) => {
    setChapter(value < 0.26 ? 0 : value < 0.5 ? 1 : value < 0.74 ? 2 : 3);
  });

  if (reduce) return <StackStoryStatic />;

  return (
    <section className="layers" id="layers" ref={sectionRef} aria-label="What Synari handles">
      <div className="layers-viewport">
        <div className="layers-rail" aria-hidden="true">
          <div className="rail-line"><motion.i style={{ scaleY: railFill }} /></div>
          {chapters.map((item, index) => (
            <div key={item.num} className={`rail-step ${chapter >= index ? "is-reached" : ""} ${chapter === index ? "is-active" : ""}`}>
              <span className="rail-diamond" />
              <span className="rail-label">{item.label}</span>
            </div>
          ))}
        </div>
        <div className="layers-stage" aria-hidden="true">
          <div className="layers-stage-inner">
            <motion.div className="stage-glow" style={{ opacity: glowOpacity }} />
            <motion.div className="stage-stack" style={{ y: stackY }}>
              <motion.div className="stage-layer" style={{ y: baseY, opacity: baseOpacity, scale: baseScale }}>
                <LayerDiamond tone="base" />
              </motion.div>
              <motion.div className="stage-layer" style={{ y: midY, opacity: midOpacity, scale: midScale }}>
                <LayerDiamond tone="mid" />
              </motion.div>
              <motion.div className="stage-layer" style={{ y: topY, opacity: topOpacity, scale: topScale }}>
                <LayerDiamond tone="top" />
              </motion.div>
            </motion.div>
            <motion.p className="stage-word" style={{ opacity: wordOpacity, y: wordY }}>Synari</motion.p>
          </div>
        </div>
        <div className="layers-panels">
          {chapters.map((item, index) => (
            <StoryPanel key={item.num} progress={progress} at={panelRanges[index]}>
              <p className="eyebrow"><span className="eyebrow-diamond" />Layer {item.num} · {item.eyebrow}</p>
              <h3>{item.title}</h3>
              <p className="story-copy">{item.copy}</p>
              <ProductMock type={item.type} />
            </StoryPanel>
          ))}
          <StoryPanel progress={progress} at={[0.78, 0.88, 0.98, 1]} final>
            <p className="eyebrow"><span className="eyebrow-diamond" />The full stack</p>
            <h3>AI that handles the work around care.</h3>
            <p className="story-copy">
              Documentation, communication, and billing — three layers working as one,
              so your attention stays with your clients.
            </p>
            <a className="panel-link" href="#how">See how it works <Icon name="arrow" size={15} /></a>
          </StoryPanel>
        </div>
      </div>
    </section>
  );
}

const convergenceNodes = [
  { icon: "calendar" as IconName, label: "Schedule", x: 120, y: 84 },
  { icon: "notes" as IconName, label: "Notes", x: 520, y: 72 },
  { icon: "message" as IconName, label: "Messages", x: 568, y: 300 },
  { icon: "bill" as IconName, label: "Billing", x: 352, y: 396 },
  { icon: "shield" as IconName, label: "Compliance", x: 76, y: 312 },
];

function Convergence() {
  const reduce = useReducedMotion();
  return (
    <section className="convergence" id="connected">
      <Reveal className="convergence-copy">
        <h2>
          The more Synari learns,
          <em>the less you have to manage.</em>
        </h2>
        <p>
          Every workflow gives the next one better context. Your schedule informs reminders.
          Sessions inform notes. Notes prepare billing. Nothing gets lost between tools.
        </p>
      </Reveal>
      <Reveal className="convergence-stage-wrap" delay={0.1}>
        <div className="convergence-stage">
          <svg className="convergence-lines" viewBox="0 0 640 440" fill="none" aria-hidden="true">
            {convergenceNodes.map((node, index) => (
              <motion.line
                key={node.label}
                x1="320"
                y1="220"
                x2={node.x}
                y2={node.y}
                stroke="rgba(13,148,136,0.35)"
                strokeWidth="1.6"
                initial={reduce ? undefined : { pathLength: 0, opacity: 0 }}
                whileInView={reduce ? undefined : { pathLength: 1, opacity: 1 }}
                viewport={{ once: true, amount: 0.6 }}
                transition={{ duration: 1, delay: 0.25 + index * 0.12, ease: easeOutSoft }}
              />
            ))}
          </svg>
          <div className="convergence-center">
            <StackMark className="convergence-mark" />
          </div>
          {convergenceNodes.map((node, index) => (
            <motion.div
              key={node.label}
              className="convergence-chip"
              style={{ left: `${(node.x / 640) * 100}%`, top: `${(node.y / 440) * 100}%`, "--float-delay": `${index * -1.3}s` } as CSSProperties}
              initial={reduce ? undefined : { opacity: 0, scale: 0.8 }}
              whileInView={reduce ? undefined : { opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.6, delay: 0.5 + index * 0.12, ease: easeOutSoft }}
            >
              <Icon name={node.icon} size={15} />
              <span>{node.label}</span>
            </motion.div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

const workflow = [
  ["01", "Prepare", "Reviews tomorrow’s schedule and flags anything that needs your attention."],
  ["02", "Support", "Keeps routine client communication moving between sessions."],
  ["03", "Document", "Creates clear clinical drafts for your review after each appointment."],
  ["04", "Close the loop", "Prepares billing and gives you a clean view of what happened."],
];

function Workflow() {
  return (
    <section className="workflow" id="how">
      <div className="workflow-glow glow-one" aria-hidden="true" />
      <div className="workflow-glow glow-two" aria-hidden="true" />
      <Reveal className="workflow-head">
        <p className="eyebrow eyebrow-light"><span className="eyebrow-diamond" />How it works</p>
        <h2>Your practice, <em>gently moving forward.</em></h2>
      </Reveal>
      <div className="workflow-cards" role="region" aria-label="How Synari works" tabIndex={0}>
        {workflow.map(([number, title, copy], index) => (
          <Reveal key={number} delay={index * 0.09}>
            <article className="workflow-card" data-step={number}>
              <span className="workflow-num">{number}</span>
              <div className="workflow-icon"><Icon name={["calendar", "message", "notes", "check"][index] as IconName} /></div>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Testimonial() {
  return (
    <section className="testimonial-section" id="practice">
      <Reveal className="testimonial">
        <div className="testimonial-photo">
          <img src="/therapy-office.jpg" alt="A calm therapy office prepared for a client session" loading="lazy" />
          <div className="testimonial-wash" />
          <span className="photo-pill"><i /> Practice running smoothly</span>
        </div>
        <blockquote>
          <StackMark className="quote-mark" />
          <p>“My attention belongs with my clients. Synari gives me more of it back.”</p>
          <footer>
            <strong>A calmer way to practice</strong>
            <span>Built for independent therapists and growing teams</span>
          </footer>
        </blockquote>
      </Reveal>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section className="faq" id="faq">
      <Reveal className="section-intro">
        <p className="eyebrow"><span className="eyebrow-diamond" />Questions</p>
        <h2>FAQ</h2>
      </Reveal>
      <div className="faq-list">
        {faqs.map(([question, answer], index) => (
          <Reveal key={question} delay={index * 0.05}>
            <article className={`faq-item ${open === index ? "open" : ""}`}>
              <button aria-expanded={open === index} onClick={() => setOpen(open === index ? -1 : index)}>
                <span>{question}</span>
                <Icon name={open === index ? "plus" : "chevron"} />
              </button>
              <div className="faq-answer">
                <p>{answer}</p>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="closing" id="demo">
      <div className="closing-backdrop" aria-hidden="true">
        <div className="hero-grid" />
        <div className="closing-glow" />
      </div>
      <Reveal className="closing-content">
        <span className="closing-stack" aria-hidden="true">
          <LayerDiamond tone="base" className="cs-base" />
          <LayerDiamond tone="mid" className="cs-mid" />
          <LayerDiamond tone="top" className="cs-top" />
        </span>
        <h2>
          More room for the work
          <em>only you can do.</em>
        </h2>
        <p>See how Synari can quietly support your practice.</p>
        <DemoForm dark />
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <Reveal className="footer-title">
        <h2>Care first.<em>Admin second.</em></h2>
        <a href="#demo">Get a demo <Icon name="arrow" /></a>
      </Reveal>
      <Reveal className="footer-links">
        <div><span>Product</span><a href="#how">How it works</a><a href="#faq">FAQ</a><a href="#demo">Demo</a></div>
        <div><span>Company</span><a href="/about">About</a><a href="mailto:gudadheer@gmail.com">Contact</a><a href="/login">Sign in</a></div>
        <div><span>Legal</span><a href="/privacy-policy">Privacy</a><a href="/terms-of-service">Terms</a></div>
      </Reveal>
      <Reveal className="footer-bottom">
        <Brand />
        <span>HIPAA-conscious by design</span>
        <span>© 2026 Synari. All rights reserved.</span>
      </Reveal>
      <div className="footer-word" aria-hidden="true" />
    </footer>
  );
}

function LandingPage() {
  const [activeSection, setActiveSection] = useState("top");
  useEffect(() => {
    const sections = ["top", "layers", "how", "faq", "demo"]
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    let frame = 0;
    const updateActiveSection = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const marker = window.innerHeight * 0.34;
        const current = sections.reduce(
          (selected, section) => (section.getBoundingClientRect().top <= marker ? section : selected),
          sections[0],
        );
        setActiveSection(current.id);
      });
    };
    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, []);
  return (
    <div className="synari-landing">
      <Nav activeSection={activeSection} onNavigate={setActiveSection} />
      <main>
        <Hero />
        <StackStory />
        <Convergence />
        <Workflow />
        <Testimonial />
        <Faq />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

export default LandingPage;
