import { Module } from '@nestjs/common';
import { ImageStudioCommand, VideoStudioCommand } from './image-video.command.js';

// Nhóm image_video: `pipelines/image_studio.py` (MKT-03 ảnh nháp ghép packshot thật, marketing-02.1),
// `pipelines/video_studio.py` (MKT-04 video nháp, marketing-02.2), `pipelines/image_provider_openrouter.py`
// (nền AI OpenRouter — chờ cổng ảnh của AI Gateway). Không có REST/webhook (Python chỉ có CLI; Studio
// lọc bỏ loại `image`/`video` khỏi tab Content Studio).

/** Lệnh CLI của nhóm — đăng ký trong CliModule (cli.ts); tự mở kết nối DATABASE_URL, không cần PG_POOL. */
export const IMAGE_VIDEO_COMMANDS = [ImageStudioCommand, VideoStudioCommand];

@Module({})
export class ImageVideoModule {}
