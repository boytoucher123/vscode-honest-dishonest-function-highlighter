#ifndef LIB_H
#define LIB_H

#define LOG(msg) Print(msg + "\n")
#define SQUARE(x) ((x) * (x))

{
  Integer g_counter = 0;
}

// Honest helper in an include
Real hypot2(Real a, Real b)
{
  return Sqrt(SQUARE(a) + SQUARE(b));
}

void log_value(Text label, Real v)
{
  LOG(label + " = " + To_text(v, 3));
}

#endif
