import type { DecisionState } from '@/lib/types';

export type FoxVariant = 'header' | DecisionState;

interface FoxMascotProps {
  variant: FoxVariant;
  size?: 'sm' | 'md';
  className?: string;
}

const VARIANT_LABELS: Record<FoxVariant, string> = {
  header: 'Sentinel fox mascot',
  blocked: 'Guard fox holding up a stop sign',
  approved: 'Guard fox in approved stance',
  needs_review: 'Guard fox in careful review stance',
};

export function FoxMascot({ variant, size = 'md', className }: FoxMascotProps) {
  const defaultDimensions = size === 'sm' ? 'w-10 h-10' : 'w-[72px] h-[72px]';
  const dimensions = className ? className : defaultDimensions;
  const headTransform =
    variant === 'needs_review' ? 'rotate(-5 52 46)' : variant === 'blocked' ? 'translate(0, -1)' : undefined;

  return (
    <svg
      viewBox="-10 0 122 104"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={VARIANT_LABELS[variant]}
      className={`${dimensions} shrink-0 select-none`}
    >
      {/* Subtle ground shadow */}
      <ellipse cx="54" cy="96" rx="31" ry="4.5" fill="#E6E2D8" />

      {/* Fluffy curved tail behind body */}
      <path
        d="M72 78C89 79 102 68 101 51C100 39 91 34 83 39C77 43 76 55 72 67Z"
        fill="#E86A2B"
        stroke="#1C1917"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      {/* Tail cream tip */}
      <path
        d="M91 36.8C96.8 38.2 100.6 43.2 101 51C96 53 90.5 51.8 87.2 47.5C85.6 44 87 39.2 91 36.8Z"
        fill="#FFF7EB"
      />

      {/* Compact sitting body */}
      <path
        d="M34 65C33 77 35 90 42 92H66C73 90 75 77 74 65C73 56 66 51 54 51C42 51 35 56 34 65Z"
        fill="#EA6D2F"
        stroke="#1C1917"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />

      {/* Cream chest fur */}
      <path
        d="M44 58C44 58 47 75 54 78C61 75 64 58 64 58C60 55 48 55 44 58Z"
        fill="#FFF7EB"
      />

      {/* Paws & props based on state */}
      {variant === 'blocked' ? (
        <>
          {/* Stop sign pole held upright */}
          <line
            x1="10"
            y1="46"
            x2="13"
            y2="74"
            stroke="#57534E"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
          <line
            x1="10"
            y1="46"
            x2="13"
            y2="74"
            stroke="#1C1917"
            strokeWidth="1.2"
            strokeLinecap="round"
          />

          {/* Octagonal red STOP sign */}
          <polygon
            points="3.9,17.2 16.1,17.2 24.8,25.9 24.8,38.1 16.1,46.8 3.9,46.8 -4.8,38.1 -4.8,25.9"
            fill="#DC2626"
            stroke="#1C1917"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
          <polygon
            points="4.8,19.4 15.2,19.4 22.6,26.8 22.6,37.2 15.2,44.6 4.8,44.6 -2.6,37.2 -2.6,26.8"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <text
            x="10"
            y="34.9"
            textAnchor="middle"
            fill="#FFFFFF"
            fontSize="8.2"
            fontWeight="800"
            fontFamily="system-ui, -apple-system, sans-serif"
            letterSpacing="0.4"
          >
            STOP
          </text>

          {/* Left arm & paw gripping the stop sign pole */}
          <path
            d="M35 66C27 65 20 62 14 59"
            stroke="#1C1917"
            strokeWidth="9.2"
            strokeLinecap="round"
          />
          <path
            d="M35 66C27 65 20 62 14 59"
            stroke="#EA6D2F"
            strokeWidth="5.4"
            strokeLinecap="round"
          />
          <circle
            cx="12.5"
            cy="58.5"
            r="4.2"
            fill="#EA6D2F"
            stroke="#1C1917"
            strokeWidth="2"
          />
          <circle cx="11.5" cy="58.5" r="1.8" fill="#FFF7EB" />

          {/* Right paw steady */}
          <ellipse cx="64" cy="90" rx="6.5" ry="4.2" fill="#292524" />
        </>
      ) : variant === 'needs_review' ? (
        <>
          {/* Left paw steady */}
          <ellipse cx="43" cy="90" rx="6.5" ry="4.2" fill="#292524" />
          {/* Right paw tucked thoughtfully near chin */}
          <path
            d="M69 68C74 64 76 58 72 54C69 51 64 54 63 59"
            fill="#EA6D2F"
            stroke="#1C1917"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <ellipse cx="43" cy="90" rx="6.5" ry="4.2" fill="#292524" />
          <ellipse cx="65" cy="90" rx="6.5" ry="4.2" fill="#292524" />
        </>
      )}

      {/* Collar strap */}
      <path
        d="M41 55.5C48 59.2 60 59.2 67 55.5"
        stroke="#1E3A8A"
        strokeWidth="3.6"
        strokeLinecap="round"
      />

      {/* Cobalt shield collar tag */}
      <g transform="translate(47, 56)">
        <path
          d="M0.5 2C0.5 1.1 1.2 0.5 2.1 0.5H11.9C12.8 0.5 13.5 1.1 13.5 2V7.2C13.5 10.9 9.7 13.6 7 14.8C4.3 13.6 0.5 10.9 0.5 7.2V2Z"
          fill="#1D4ED8"
          stroke="#1C1917"
          strokeWidth="1.6"
        />
        {variant === 'approved' ? (
          <path
            d="M4.3 7.4L6.2 9.3L9.9 5.3"
            stroke="#FFFFFF"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : variant === 'blocked' ? (
          <path
            d="M4.8 5.2L9.2 9.6M9.2 5.2L4.8 9.6"
            stroke="#FFFFFF"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        ) : variant === 'needs_review' ? (
          <circle cx="7" cy="7.2" r="2.1" fill="#FFFFFF" />
        ) : (
          <path
            d="M7 4.2V10.2M4.3 7.2H9.7"
            stroke="#FFFFFF"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        )}
      </g>

      {/* Expressive Head Group */}
      <g transform={headTransform}>
        {/* Left & Right Ears */}
        <path
          d="M32 34L27 12C26.5 9.8 29.1 8.4 31 9.8L45 21Z"
          fill="#EA6D2F"
          stroke="#1C1917"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <path d="M33 30L30 15L41 23Z" fill="#FFF1DF" />

        <path
          d={
            variant === 'needs_review'
              ? 'M76 34L84 11C84.8 8.8 82 7.5 80.1 9.1L64 21Z'
              : 'M76 34L81 12C81.5 9.8 78.9 8.4 77 9.8L63 21Z'
          }
          fill="#EA6D2F"
          stroke="#1C1917"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <path d="M75 30L78 15L67 23Z" fill="#FFF1DF" />

        {/* Head Silhouette */}
        <path
          d="M27 38C27 25 38 18 54 18C70 18 81 25 81 38C81 48 69 56 54 56C39 56 27 48 27 38Z"
          fill="#F27938"
          stroke="#1C1917"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />

        {/* Cream cheeks & muzzle */}
        <path
          d="M28.5 39C33 36 42 38 48 44C50.5 46.5 52 46.5 54 46.5C56 46.5 57.5 46.5 60 44C66 38 75 36 79.5 39C78 48.5 67.5 55 54 55C40.5 55 30 48.5 28.5 39Z"
          fill="#FFF7EB"
        />

        {/* Eyes & Eyebrows per state */}
        {variant === 'approved' ? (
          <>
            {/* Happy warm eyes */}
            <path
              d="M38.5 34.5C40 31.8 43.8 31.8 45.2 34.5"
              stroke="#1C1917"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path
              d="M62.8 34.5C64.2 31.8 68 31.8 69.5 34.5"
              stroke="#1C1917"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </>
        ) : variant === 'blocked' ? (
          <>
            {/* Alert attentive eyes + firm brow */}
            <circle cx="42" cy="34.5" r="2.9" fill="#1C1917" />
            <circle cx="43" cy="33.5" r="0.9" fill="#FFFFFF" />
            <circle cx="66" cy="34.5" r="2.9" fill="#1C1917" />
            <circle cx="67" cy="33.5" r="0.9" fill="#FFFFFF" />
            <path
              d="M38 28.5L45.5 30.8"
              stroke="#1C1917"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M70 28.5L62.5 30.8"
              stroke="#1C1917"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </>
        ) : variant === 'needs_review' ? (
          <>
            {/* Curious inspecting eyes */}
            <circle cx="42" cy="34.5" r="3" fill="#1C1917" />
            <circle cx="43.1" cy="33.5" r="1" fill="#FFFFFF" />
            <circle cx="66" cy="34.5" r="3" fill="#1C1917" />
            <circle cx="67.1" cy="33.5" r="1" fill="#FFFFFF" />
            <path
              d="M38 29.2C40 27.6 43 27.8 45 29"
              stroke="#1C1917"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M63 27.8C65.2 26.4 68.5 26.8 70.2 28.6"
              stroke="#1C1917"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </>
        ) : (
          <>
            {/* Friendly alert header eyes */}
            <circle cx="42" cy="34.5" r="2.8" fill="#1C1917" />
            <circle cx="43" cy="33.5" r="0.95" fill="#FFFFFF" />
            <circle cx="66" cy="34.5" r="2.8" fill="#1C1917" />
            <circle cx="67" cy="33.5" r="0.95" fill="#FFFFFF" />
          </>
        )}

        {/* Nose */}
        <path
          d="M50.5 41.5C50.5 40.2 51.8 39.5 54 39.5C56.2 39.5 57.5 40.2 57.5 41.5C57.5 43.1 55.6 44.8 54 44.8C52.4 44.8 50.5 43.1 50.5 41.5Z"
          fill="#1C1917"
        />

        {/* Mouth expression */}
        {variant === 'blocked' ? (
          <path
            d="M50.5 48.8C52.5 47.4 55.5 47.4 57.5 48.8"
            stroke="#1C1917"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        ) : variant === 'needs_review' ? (
          <path
            d="M51 48.2C52.8 48.8 55.2 48.2 56.8 47.4"
            stroke="#1C1917"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M49.5 47.3C51.2 49.4 53.2 49.3 54 47.9C54.8 49.3 56.8 49.4 58.5 47.3"
            stroke="#1C1917"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </g>
    </svg>
  );
}
