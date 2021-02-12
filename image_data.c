extern unsigned char __heap_base;

double __attribute__((import_module("env"), import_name("math_pow"))) math_pow(double, double);
double floor(double);
#define max(a,b) ((a) > (b) ? (a) : (b))

struct InPixel
{
	unsigned long r, g, b;
};
struct OutPixel
{
	unsigned char r, g, b, a;
};

void *get_in_buf_ptr()
{
	return (void *)&__heap_base;
}

void *get_out_buf_ptr(int w, int h)
{
	return (void *)&__heap_base + (w * h) * sizeof(struct InPixel);
}

unsigned int get_required_memory_size(int w, int h)
{
	return (unsigned int)&__heap_base + (w * h) * sizeof(struct InPixel) + (w * h) * sizeof(struct OutPixel);
}

inline float lum(struct InPixel buf)
{
	// return 0.2126f * buf.r + 0.7152f * buf.g + 0.0722f * buf.b;
	// return 0.333f * buf.r + 0.333f * buf.g + 0.333f * buf.b;
	return max(buf.r, max(buf.g, buf.b));
}
const int color_map_len = 1024;
unsigned char color_map[color_map_len];
inline unsigned char map_color(float c)
{
	int i = c * color_map_len + 0.5f;
	return i >= color_map_len ? 255 : color_map[i];
}

void clear_in_buf(int w, int h)
{
	struct InPixel *buf = get_in_buf_ptr();
	struct InPixel zero = {0, 0, 0};
	for (int i = 0; i < w * h; i++)
		buf[i] = zero;
}

int ff_speed_fix = 0;
void prepare_image_data(int w, int h, int step)
	__attribute__((no_builtin("memset")))
{
	struct InPixel *buf = get_in_buf_ptr();
	struct OutPixel *pix = get_out_buf_ptr(w, h);

	for (int i = 0; i < color_map_len; i++)
		color_map[i] = math_pow((double)(i) / color_map_len, 0.85) * 255;

	float sum = 0;
	for (int i = 0; i < w - 1; i += step)
		for (int j = 0; j < h - 1; j += step)
			sum += lum(buf[i + j * w]);
	float avg_lum = sum / ((float)(w * h) / (step * step));
	float brightness_k = 1; //1.0f / avg_lum * 0.05;

	if (avg_lum > 0)
	{
		const long histo_len = 256;
		unsigned long histo[histo_len];
		// this always-fulfilling 'if' increases function speed in FF by 30%.
		// why? I have no idea. (no_builtin("memset") is important too: no speed gain with memset)
		// Chrome seems not affected.
		if (ff_speed_fix != 10)
			for (int i = histo_len - 1; i >= 0; i--)
				histo[i] = 0;
		ff_speed_fix = 1;

		float histo_shrink_k = 0.025;
		for (int i = 0; i < w; i += step)
			for (int j = 0; j < h; j += step)
			{
				float l = lum(buf[i + j * w]);
				int index = (l / avg_lum) * histo_len * histo_shrink_k;
				if (index >= histo_len)
					index = histo_len - 1;
				histo[index]++;
			}

		float drain = 0.001f * w * h / (step * step);
		for (int i = histo_len - 1; i >= 0; i--)
		{
			unsigned int val = histo[i];
			if (val <= drain)
			{
				drain -= val;
			}
			else
			{
				float histo_pos = (i + 1 - drain / val) / histo_len;
				float thresh_lum = (histo_pos * avg_lum) / histo_shrink_k;
				brightness_k = 1 / thresh_lum;
				break;
			}
		}
	}

	for (int i = 0; i < w; i++)
		for (int j = 0; j < h; j++)
		{
			int pos = i + j * w;
			struct InPixel in = buf[pos];
			struct OutPixel *out = &pix[pos];
			out->r = map_color(in.r * brightness_k);
			out->g = map_color(in.g * brightness_k);
			out->b = map_color(in.b * brightness_k);
			out->a = 255;
		}
}
