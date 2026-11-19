#include "lib.h"

/* global block */
{
  Text g_name;
}

Integer is_even(Integer n)          // recursion between honest functions
{
  if (n == 0) return 1;
  return is_odd(n - 1);
}

Integer is_odd(Integer n)
{
  if (n == 0) return 0;
  return is_even(n - 1);
}

Text describe(Integer n)            // honest: only text built-ins
{
  Text s = To_text(n);
  return "Value: " + s;
}

void bump()                          // dishonest: global from include
{
  g_counter++;
}

Text name_of(Element e)              // honest: element handle overload
{
  Text name;
  Get_name(e, name);
  return name;
}

Integer stamp(Text &out)             // dishonest: clock
{
  Integer t;
  Get_time(t);
  out = describe(t);
  return t;
}

Integer outer(Integer x)             // dishonest by propagation
{
  Text tmp;
  stamp(tmp);
  return is_even(x);
}

Integer mystery()                    // unknown function
{
  return Not_a_real_function(1);
}

void main()
{
  Real d = hypot2(3.0, 4.0);
  log_value("d", d);
  Print(describe(outer(2)));
  g_name = "x";
}
