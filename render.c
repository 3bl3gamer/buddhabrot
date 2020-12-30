#include <stdint.h>

extern unsigned char __heap_base;

#define PI 3.1415926
double floor(double);
double fabs(double);

struct Point
{
	double x, y, a, b;
};

struct Pixel
{
	unsigned int r, g, b;
};

double transformMatrix[8] = {0, 1, 0, 0, 1, 0, 0, 0};

unsigned int get_required_memory_size(int iters, int w, int h)
{
	return (unsigned int)&__heap_base + (w * h) * sizeof(struct Pixel) + sizeof(struct Point) * iters;
}

void *get_color_buf_ptr()
{
	return (void *)&__heap_base;
}

void *get_transform_matrix_ptr()
{
	return (void *)&transformMatrix;
}

double hue2rgb(double p, double q, double t)
{
	if (t < 0)
		t += 1;
	if (t > 1)
		t -= 1;
	if (t < 1. / 6)
		return p + (q - p) * 6 * t;
	if (t < 1. / 2)
		return q;
	if (t < 2. / 3)
		return p + (q - p) * (2. / 3 - t) * 6;
	return p;
}
struct Pixel hslToRgb(double h, double s, double l)
{
	double r, g, b;

	if (s == 0)
	{
		r = g = b = l; // achromatic
	}
	else
	{
		double q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		double p = 2 * l - q;
		r = hue2rgb(p, q, h + 1. / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1. / 3);
	}

	struct Pixel pix = {floor(r * 255.999), floor(g * 255.999), floor(b * 255.999)};
	return pix;
}

/*double atan2_(double y, double x)
{
	double abs_y = fabs(y) + 1e-10;
	double angle;
	if (x >= 0)
	{
		double r = (x - abs_y) / (x + abs_y);
		angle = 0.1963 * r * r * r - 0.9817 * r + 0.7853981633974483;
	}
	else
	{
		double r = (x + abs_y) / (abs_y - x);
		angle = 0.1963 * r * r * r - 0.9817 * r + 2.356194490192345;
	}
	return y < 0 ? -angle : angle;
}*/
double atan2(double y, double x)
{
	//http://pubs.opengroup.org/onlinepubs/009695399/functions/atan2.html
	//Volkan SALMA

	const double ONEQTR_PI = PI / 4.0;
	const double THRQTR_PI = 3.0 * PI / 4.0;
	double r, angle;
	double abs_y = fabs(y) + 1e-10f; // kludge to prevent 0/0 condition
	if (x < 0.0f)
	{
		r = (x + abs_y) / (abs_y - x);
		angle = THRQTR_PI;
	}
	else
	{
		r = (x - abs_y) / (x + abs_y);
		angle = ONEQTR_PI;
	}
	angle += (0.1963f * r * r - 0.9817f) * r;
	if (y < 0.0f)
		return -angle; // negate if in quad III or IV
	else
		return angle;
}

// https://www.pcg-random.org/download.html
// *Really* minimal PCG32 code / (c) 2014 M.E. O'Neill / pcg-random.org
// Licensed under Apache License 2.0 (NO WARRANTY, etc. see website)

typedef struct
{
	uint64_t state;
	uint64_t inc;
} pcg32_random_t;

static pcg32_random_t pcg32_global = {0x853c49e6748fea9bULL, 0xda3e39cb94b95bdbULL};

uint32_t pcg32_random_r(pcg32_random_t *rng)
{
	uint64_t oldstate = rng->state;
	// Advance internal state
	rng->state = oldstate * 6364136223846793005ULL + (rng->inc | 1);
	// Calculate output function (XSH RR), uses old state for max ILP
	uint32_t xorshifted = ((oldstate >> 18u) ^ oldstate) >> 27u;
	uint32_t rot = oldstate >> 59u;
	return (xorshifted >> rot) | (xorshifted << ((-rot) & 31));
}

uint32_t pcg32_random()
{
	return pcg32_random_r(&pcg32_global);
}

void pcg32_srandom_r(pcg32_random_t *rng, uint64_t initstate, uint64_t initseq)
{
	rng->state = 0U;
	rng->inc = (initseq << 1u) | 1u;
	pcg32_random_r(rng);
	rng->state += initstate;
	pcg32_random_r(rng);
}

void pcg32_srandom(uint64_t seed, uint64_t seq)
{
	pcg32_srandom_r(&pcg32_global, seed, seq);
}

void srand(unsigned long seed)
{
	pcg32_srandom(0, seed);
}

void render(int w, int h, int iters, int samples)
{
	struct Pixel *buf = (struct Pixel *)(&__heap_base);
	struct Point *points = (struct Point *)(&__heap_base + (w * h) * sizeof(struct Pixel));

	double m0 = transformMatrix[0];
	double m1 = transformMatrix[1];
	double m2 = transformMatrix[2];
	double m3 = transformMatrix[3];
	double m4 = transformMatrix[4];
	double m5 = transformMatrix[5];
	double m6 = transformMatrix[6];
	double m7 = transformMatrix[7];

	for (int i = 0; i < samples; i++)
	{
		double cx = ((double)pcg32_random()) / UINT32_MAX * 4 - 2;
		double cy = ((double)pcg32_random()) / UINT32_MAX * 4 - 2;
		double a = cx;
		double b = cy;
		int iter = iters;
		while (iter > 0)
		{
			iter--;
			double aa = a * a;
			double bb = b * b;
			// if (aa + bb > 4) break
			if (aa > 4 || bb > 4)
				break;
			b = 2 * a * b + cy;
			a = aa - bb + cx;
			struct Point *point = &points[iter]; //TODO: Point{...}
			point->x = a * m0 + b * m1 + cx * m2 + cy * m3;
			point->y = a * m4 + b * m5 + cx * m6 + cy * m7;
			point->a = a;
			point->b = b;

			int x = floor(((cx + 2) / 4) * w);
			int y = floor(((cy + 2) / 4) * h);
			// buf[x + y * w].r++;
		}
		if (iter != 0)
		{
			for (int k = iter + 2; k < iters - 2; k++)
			{
				struct Point *point = &points[k]; //TODO:without ptr
				double a = point->a;
				double b = point->b;
				int x = floor(((point->x + 2) / 4) * w);
				int y = floor(((point->y + 2) / 4) * h);
				if (x >= 0 && y >= 0 && x < w && y < h)
				{
					double yk = 1;
					double angle0 = atan2((b - points[k - 1].b) * yk, a - points[k - 1].a);
					double angle1 = atan2((points[k + 1].b - b) * yk, points[k + 1].a - a);
					double dak = fabs(angle1 - angle0) / PI;
					if (dak > 1)
						dak = 2 - dak;
					struct Pixel inc = hslToRgb(dak, 1, 0.5);
					struct Pixel *pix = &buf[x + y * w];
					pix->r += inc.r;
					pix->g += inc.g;
					pix->b += inc.b;
				}
			}
		}
	}
}
