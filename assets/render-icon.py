from PIL import Image, ImageDraw
S = 180
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=40, fill=(28, 32, 40, 255))
k = S / 24.0
white = (255, 255, 255, 255)
def line(x1, y1, x2, y2, w):
    d.line([x1 * k, y1 * k, x2 * k, y2 * k], fill=white, width=max(2, int(round(w * k))))
line(4.5, 7, 19.5, 7, 3.4)
line(10, 4, 14, 4, 3.4)
line(6.4, 7.4, 7.4, 18.6, 3.0)
line(17.6, 7.4, 16.6, 18.6, 3.0)
d.arc([7.2 * k, 14.6 * k, 16.8 * k, 21.4 * k], 0, 180, fill=white, width=max(2, int(round(3.0 * k))))
line(10, 10.5, 10, 16.5, 2.6)
line(14, 10.5, 14, 16.5, 2.6)
img.save('G:/Dev/dsh-session-delete/assets/icon-180.png')
print('saved 180x180')